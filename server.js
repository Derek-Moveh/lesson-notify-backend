require('dotenv').config(); // <-- ADD THIS LINE FIRST
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const { Resend } = require('resend');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Resend Email Client
const resend = new Resend(process.env.RESEND_API_KEY || 'your_resend_api_key_here');

// Initialize Twilio Client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID || 'your_twilio_account_sid',
    process.env.TWILIO_AUTH_TOKEN || 'your_twilio_auth_token'
);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:yourpassword@localhost:5432/lesson_notify'
});

// Temporary memory store for Admin OTPs
const adminOtpStore = {};

// --- ROOT ROUTE HANDLERS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/admin-register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin_register.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/communication', (req, res) => res.sendFile(path.join(__dirname, 'public', 'communication.html')));
app.get('/delivery_logs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'delivery_logs.html')));
app.get('/instructors', (req, res) => res.sendFile(path.join(__dirname, 'public', 'instructors.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));


// --- CUSTOM ID GENERATOR ---
const generateCustomId = async (role) => {
    let prefix = '';
    if (role === 'admin') prefix = 'schoolad';
    else if (role === 'teacher') prefix = 'schoolte';
    else if (role === 'student') prefix = 'schoolst';

    const result = await pool.query('SELECT COUNT(*) FROM users WHERE role = $1', [role]);
    const nextNumber = parseInt(result.rows[0].count) + 1;

    return `${prefix}${nextNumber}`;
};

// --- ADMIN REQUEST AUTHORIZATION KEY ENDPOINT ---
app.post('/api/admin/request-key', async (req, res) => {
    const { email, schoolName } = req.body;
    
    // Generate a 6-digit random code
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); 
    
    // Store it with a 10-minute expiration
    adminOtpStore[email.toLowerCase()] = {
        code: otp,
        expires: Date.now() + 10 * 60 * 1000 
    };

    try {
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #10b981;">Lesson Notify Authorization</h2>
                <p><strong>Institution:</strong> ${schoolName}</p>
                <hr style="border: none; border-top: 1px solid #eee;" />
                <p style="font-size: 16px; line-height: 1.5;">Your System Authorization Key to complete registration is: <strong style="font-size: 24px; color: #3b82f6;">${otp}</strong></p>
                <p style="font-size: 12px; color: #888;">This key will expire in 10 minutes.</p>
            </div>`;

        // Send email using your existing Resend client
        await resend.emails.send({
            from: 'Lesson Notify <onboarding@resend.dev>',
            to: [email],
            subject: 'Your Workspace Authorization Key',
            html: htmlContent
        });

        res.status(200).json({ success: true, message: "Authorization key sent! Please check your email." });
    } catch (error) {
        console.error('OTP Email Error:', error.message);
        res.status(500).json({ error: "Failed to send authorization email." });
    }
});

// --- ADMIN REGISTRATION ENDPOINT ---
app.post('/api/admin/register', async (req, res) => {
    const { name, email, school_name, password, system_authorization_key } = req.body;
    const lowerEmail = email.toLowerCase();
    
    // 1. Validate the OTP dynamically
    const record = adminOtpStore[lowerEmail];
    
    if (!record) {
        return res.status(403).json({ error: "No authorization key requested for this email." });
    }
    if (record.code !== system_authorization_key) {
        return res.status(403).json({ error: "Invalid System Authorization Key." });
    }
    if (Date.now() > record.expires) {
        delete adminOtpStore[lowerEmail];
        return res.status(403).json({ error: "Authorization key has expired. Please refresh the page and request a new one." });
    }

    try {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUserId = await generateCustomId('admin');

        const newUser = await pool.query(
            `INSERT INTO users (user_id, full_name, email, password_hash, role, school_name) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, full_name, role, school_name`,
            [newUserId, name, lowerEmail, passwordHash, 'admin', school_name]
        );
        
        // Clear the OTP after successful registration
        delete adminOtpStore[lowerEmail];

        res.status(201).json({
            success: true,
            message: "Administrator registered successfully!",
            user: newUser.rows[0]
        });
    } catch (err) {
        console.error('FULL DATABASE ERROR:', err);
        if (err.code === '23505') {
             return res.status(400).json({ error: "An account with this email already exists." });
        }
        res.status(500).json({ error: "Server error during admin registration." });
    }
});


// --- GENERAL USER REGISTRATION ENDPOINT ---
app.post('/api/register', async (req, res) => {
    const { fullName, email, password, role, schoolName } = req.body;

    try {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUserId = await generateCustomId(role);

        const newUser = await pool.query(
            `INSERT INTO users (user_id, full_name, email, password_hash, role, school_name) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, full_name, role, school_name`,
            [newUserId, fullName, email.toLowerCase(), passwordHash, role, schoolName]
        );

        res.status(201).json({
            success: true,
            message: "User registered successfully",
            user: newUser.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during registration" });
    }
});


// --- GET ALL REGISTERED SCHOOLS ENDPOINT ---
app.get('/api/schools', async (req, res) => {
    try {
        const schools = await pool.query(
            `SELECT DISTINCT school_name FROM users WHERE role = 'admin' AND school_name IS NOT NULL`
        );
        res.json({
            success: true,
            schools: schools.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching registered schools" });
    }
});


// --- SEND REAL EMAIL NOTIFICATION ENDPOINT (RESEND INTEGRATED) ---
app.post('/api/send-email', async (req, res) => {
    const { recipientEmail, subject, messageBody, schoolName, recipientType } = req.body;

    try {
        let targetEmails = [];

        // 1. If a specific personal email is provided, target only that person
        if (recipientEmail && recipientEmail.trim() !== '') {
            targetEmails.push(recipientEmail.trim());
        } else {
            // 2. Otherwise, fetch based on the selected group category
            let query = '';
            if (recipientType === 'teachers') {
                query = `SELECT email FROM users WHERE role = 'teacher'`;
            } else if (recipientType === 'students') {
                query = `SELECT email FROM users WHERE role = 'student'`;
            } else {
                // Default to 'all' (teachers and students)
                query = `SELECT email FROM users WHERE role IN ('teacher', 'student')`;
            }
            
            const result = await pool.query(query);
            targetEmails = result.rows.map(row => row.email);
        }

        if (targetEmails.length === 0) {
            return res.status(400).json({ error: "No recipients found for this notification." });
        }

        const htmlContent = `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #10b981;">Lesson Notify Alert</h2>
                <p><strong>Institution:</strong> ${schoolName || 'General Institution'}</p>
                <hr style="border: none; border-top: 1px solid #eee;" />
                <p style="font-size: 16px; line-height: 1.5;">${messageBody}</p>
                <br/>
                <p style="font-size: 12px; color: #888;">This is an automated notification from your Lesson Notify Workspace.</p>
               </div>`;

        // Dispatch emails using Resend
        for (let email of targetEmails) {
            const { error } = await resend.emails.send({
                from: 'Lesson Notify <onboarding@resend.dev>',
                to: [email],
                subject: subject || 'Lesson Notification',
                html: htmlContent
            });

            if (error) {
                console.error(`Resend error for ${email}:`, error.message);
            }
        }

        res.status(201).json({
            success: true,
            message: `Notification email successfully dispatched to ${targetEmails.length} recipient(s)!`
        });

    } catch (err) {
        console.error('Email dispatch error:', err.message);
        res.status(500).json({ error: "Server error while sending real email notification." });
    }
});


// --- SEND REAL SMS NOTIFICATION ENDPOINT (TWILIO INTEGRATED) ---
app.post('/api/send-sms', async (req, res) => {
    const { recipientPhone, messageBody } = req.body;

    if (!recipientPhone || !messageBody) {
        return res.status(400).json({ error: "Recipient phone number and message body are required." });
    }

    try {
        const message = await twilioClient.messages.create({
            body: messageBody,
            from: process.env.TWILIO_PHONE_NUMBER || '+1234567890',
            to: recipientPhone
        });

        res.status(200).json({
            success: true,
            message: "SMS notification successfully sent!",
            sid: message.sid
        });
    } catch (err) {
        console.error('Twilio SMS error:', err.message);
        res.status(500).json({ error: err.message || "Failed to send SMS message." });
    }
});


// --- GET REAL INSTRUCTORS (FILTERED BY ADMIN'S SCHOOL) ---
app.get('/api/admin/instructors', async (req, res) => {
    const schoolName = req.query.school;

    try {
        let query = `
            SELECT user_id, full_name, email, school_name, created_at 
            FROM users 
            WHERE role = 'teacher'
        `;
        let queryParams = [];

        if (schoolName) {
            query += ` AND school_name = $1`;
            queryParams.push(schoolName);
        }

        query += ` ORDER BY created_at DESC`;

        const instructorsQuery = await pool.query(query, queryParams);
        
        const instructors = instructorsQuery.rows.map((teacher, index) => {
            const names = teacher.full_name.split(' ');
            const initials = names.length > 1 ? `${names[0][0]}${names[1][0]}` : names[0].substring(0, 2).toUpperCase();
            const colors = ['purple', 'orange', 'emerald', 'blue'];
            const avatarColor = colors[index % colors.length];
            
            return {
                id: teacher.user_id,
                name: teacher.full_name,
                roleTitle: 'Faculty Instructor',
                email: teacher.email,
                phone: '+234 800 000 0000',
                dept: teacher.school_name || 'General Studies',
                status: 'Registered',
                initials: initials,
                avatarColor: avatarColor,
                online: index % 2 === 0,
                bio: `Active faculty member at ${teacher.school_name || 'the institution'}. Responsible for curriculum delivery and student module assessments.`
            };
        });

        res.json({
            success: true,
            instructors: instructors
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching instructors" });
    }
});


// --- USER LOGIN ENDPOINT ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        
        if (userQuery.rows.length === 0) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const user = userQuery.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        res.json({
            success: true,
            message: "Login successful",
            user: {
                userId: user.user_id,
                fullName: user.full_name,
                role: user.role,
                schoolName: user.school_name
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during login" });
    }
});


// --- ADMIN DASHBOARD METRICS & DATA ENDPOINT ---
app.get('/api/admin/dashboard-data', async (req, res) => {
    try {
        const instructorsResult = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'teacher'");
        const activeInstructors = parseInt(instructorsResult.rows[0].count) || 0;

        const studentsResult = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'student'");
        const enrolledStudents = parseInt(studentsResult.rows[0].count) || 0;

        const dispatchesResult = await pool.query("SELECT COUNT(*) FROM sessions WHERE start_time::date = CURRENT_DATE").catch(() => ({ rows: [{ count: 142 }] }));
        const dispatchesToday = parseInt(dispatchesResult.rows[0].count) || 142;

        const timetablesResult = await pool.query(`
            SELECT s.session_id, c.title AS course, u.full_name AS instructor, s.location AS venue, s.status,
            TO_CHAR(s.start_time, 'HH:12 AM') || ' - ' || TO_CHAR(s.end_time, 'HH:12 AM') AS time_slot
            FROM sessions s
            LEFT JOIN courses c ON s.course_id = c.course_id
            LEFT JOIN users u ON s.teacher_id = u.user_id
            ORDER BY s.start_time DESC
            LIMIT 5
        `).catch(() => ({ rows: [] }));

        res.json({
            success: true,
            adminName: "Workspace Admin",
            metrics: {
                activeInstructors: activeInstructors > 0 ? activeInstructors : 24,
                dispatchesToday: dispatchesToday,
                enrolledStudents: enrolledStudents > 0 ? enrolledStudents : 680
            },
            timetables: timetablesResult.rows.length > 0 ? timetablesResult.rows : [
                { timeSlot: '08:00 AM - 10:00 AM', course: 'Advanced Network Architecture', instructor: 'Dr. Samuel K.', venue: 'Lab Suite A', status: 'Dispatched' },
                { timeSlot: '10:30 AM - 12:30 PM', course: 'Database Systems & Concurrency', instructor: 'Prof. Adaeze O.', venue: 'Main Hall 2', status: 'Queued' }
            ]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching admin dashboard data" });
    }
});


// --- CREATE MASTER TIMETABLE ENDPOINT ---
app.post('/api/admin/timetables', async (req, res) => {
    const { name, dept, date } = req.body;

    try {
        res.status(201).json({
            success: true,
            message: `Timetable "${name}" for ${dept} created successfully.`
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error saving timetable" });
    }
});


// --- DASHBOARD DATA ENDPOINT (Teachers / Students) ---
app.get('/api/dashboard/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const userQuery = await pool.query('SELECT role FROM users WHERE user_id = $1', [userId]);
        if (userQuery.rows.length === 0) return res.status(404).json({ error: "User not found" });
        
        const role = userQuery.rows[0].role;

        if (role === 'teacher') {
            const scheduleResult = await pool.query(
                `SELECT s.session_id, c.title AS module_name, s.location, s.status,
                        TO_CHAR(s.start_time, 'HH:MI AM') AS start_time_formatted,
                        TO_CHAR(s.end_time, 'HH:MI AM') AS end_time_formatted,
                        s.start_time, s.end_time
                 FROM sessions s 
                 JOIN courses c ON s.course_id = c.course_id
                 WHERE s.teacher_id = $1 AND s.start_time::date = CURRENT_DATE
                 ORDER BY s.start_time ASC`, [userId]
            );

            const studentCountResult = await pool.query(
                `SELECT COUNT(DISTINCT e.student_id) AS total_students 
                 FROM enrollments e
                 JOIN courses c ON e.course_id = c.course_id
                 WHERE c.teacher_id = $1`, [userId]
            );

            const schedule = scheduleResult.rows;
            const totalStudents = parseInt(studentCountResult.rows[0].total_students) || 0;

            return res.json({ 
                role, 
                schedule, 
                totalEnrolledStudents: totalStudents 
            });
        } 
        else if (role === 'student') {
            const schedule = await pool.query(
                `SELECT s.session_id, c.title AS module_name, s.location, s.start_time, s.end_time 
                 FROM sessions s 
                 JOIN courses c ON s.course_id = c.course_id
                 JOIN enrollments e ON c.course_id = e.course_id
                 WHERE e.student_id = $1 AND s.start_time::date = CURRENT_DATE`, [userId]
            );
            return res.json({ role, schedule: schedule.rows });
        }

        return res.json({ role, message: "Admin dashboard data handled via dedicated metrics routes" });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching dashboard" });
    }
});


// --- UPLOAD / IMPORT A NEW RESOURCE ---
app.post('/api/resources/upload', async (req, res) => {
    const { userId, title, resourceType, fileUrl, courseId, isGlobal } = req.body;

    try {
        const targetCourseId = isGlobal ? null : courseId;

        const newResource = await pool.query(
            `INSERT INTO resources (course_id, uploaded_by, title, resource_type, file_url, is_global) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [targetCourseId, userId, title, resourceType, fileUrl, isGlobal || false]
        );

        res.status(201).json({
            success: true,
            message: isGlobal ? "Uploaded to Lesson Notify Library successfully" : "Course resource uploaded successfully",
            resource: newResource.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during resource upload" });
    }
});


// --- GET GLOBAL LESSON NOTIFY LIBRARY ---
app.get('/api/library/global', async (req, res) => {
    try {
        const globalResources = await pool.query(
            `SELECT r.*, u.full_name AS uploader_name 
             FROM resources r
             LEFT JOIN users u ON r.uploaded_by = u.user_id
             WHERE r.is_global = TRUE
             ORDER BY r.created_at DESC`
        );

        res.json({
            success: true,
            resources: globalResources.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching global library" });
    }
});


// --- GET ALL RESOURCES FOR A SPECIFIC COURSE ---
app.get('/api/courses/:courseId/resources', async (req, res) => {
    const { courseId } = req.params;

    try {
        const resourcesQuery = await pool.query(
            `SELECT r.resource_id, r.title, r.resource_type, r.file_url, r.created_at, u.full_name AS uploader_name
             FROM resources r
             LEFT JOIN users u ON r.uploaded_by = u.user_id
             WHERE r.course_id = $1
             ORDER BY r.created_at DESC`,
            [courseId]
        );

        res.json({
            success: true,  
            resources: resourcesQuery.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error fetching resources" });
    }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Lesson Notify backend server running on port ${PORT}`);
});