const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve static frontend files from a 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = 'lesson_notify_secure_institutional_key_2026';

// Connect to SQLite Database
const db = new sqlite3.Database('./lesson_notify.db', (err) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('📦 Connected to SQLite database: lesson_notify.db');
    }
});

// Middleware to verify JWT Token & authenticate workspace sessions
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token missing or invalid.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token expired or invalid session.' });
        }
        req.user = user;
        next();
    });
}

// 1. SIGNUP ENDPOINT
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, name, role, phone, school_name } = req.body;

    if (!email || !password || !school_name || !role) {
        return res.status(400).json({ error: 'Missing required registration parameters.' });
    }

    try {
        db.get(`SELECT id FROM schools WHERE name = ?`, [school_name], async (err, school) => {
            let schoolId;
            
            if (school) {
                schoolId = school.id;
            } else {
                await new Promise((resolve, reject) => {
                    db.run(`INSERT INTO schools (name) VALUES (?)`, [school_name], function(err) {
                        if (err) reject(err);
                        else {
                            schoolId = this.lastID;
                            resolve();
                        }
                    });
                });
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            db.run(
                `INSERT INTO users (name, email, password, role, phone, school_id) VALUES (?, ?, ?, ?, ?, ?)`,
                [name || 'User', email, hashedPassword, role, phone || '', schoolId],
                function(err) {
                    if (err) {
                        return res.status(400).json({ error: 'Email address is already registered in the system.' });
                    }

                    const token = jwt.sign(
                        { id: this.lastID, email, role, school_id: schoolId },
                        JWT_SECRET,
                        { expiresIn: '7d' }
                    );
                    
                    res.status(201).json({
                        token,
                        role,
                        name: name || 'User',
                        school_id: schoolId
                    });
                }
            );
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server security trace failure.' });
    }
});

// 2. SIGNIN ENDPOINT
app.post('/api/auth/signin', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Please enter both email and password.' });
    }

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid email or password credentials.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password credentials.' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, school_id: user.school_id },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            role: user.role,
            name: user.name,
            school_id: user.school_id
        });
    });
});

// 3. DYNAMIC DASHBOARD STATS & SCHEDULES ENDPOINT
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
    const { school_id, id, role } = req.user;

    db.serialize(() => {
        let stats = {};

        // Count active instructors in the workspace
        db.get(`SELECT COUNT(*) as count FROM users WHERE school_id = ? AND role = 'teacher'`, [school_id], (err, row) => {
            stats.activeInstructors = row ? row.count : 0;

            // Count enrolled students in the workspace
            db.get(`SELECT COUNT(*) as count FROM users WHERE school_id = ? AND role = 'student'`, [school_id], (err, row) => {
                stats.enrolledStudents = row ? row.count : 0;

                // Count total schedules / classes today
                db.get(`SELECT COUNT(*) as count FROM timetables WHERE school_id = ?`, [school_id], (err, row) => {
                    stats.schedulesToday = row ? row.count : 0;

                    // Build query for timetables based on role permissions
                    let query = `
                        SELECT timetables.*, users.name as instructor_name 
                        FROM timetables 
                        LEFT JOIN users ON timetables.teacher_id = users.id 
                        WHERE timetables.school_id = ?
                    `;
                    let params = [school_id];

                    // If user is a teacher, restrict schedule view to their assigned classes
                    if (role === 'teacher') {
                        query += ` AND timetables.teacher_id = ?`;
                        params.push(id);
                    }

                    db.all(query, params, (err, rows) => {
                        stats.schedules = rows || [];
                        res.json(stats);
                    });
                });
            });
        });
    });
});

// 4. ADD TIMETABLE ENDPOINT (Admin Only)
app.post('/api/timetables', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized: Only facility administrators can modify timetables.' });
    }

    const { title, teacher_id, venue, day_of_week, start_time, end_time } = req.body;
    const school_id = req.user.school_id;

    if (!title || !teacher_id || !venue || !day_of_week || !start_time || !end_time) {
        return res.status(400).json({ error: 'Please fill in all required timetable fields.' });
    }

    db.run(
        `INSERT INTO timetables (school_id, title, teacher_id, venue, day_of_week, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Dispatched')`,
        [school_id, title, teacher_id, venue, day_of_week, start_time, end_time],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to create schedule entry in database.' });
            }
            res.status(201).json({ message: 'Timetable created and notifications queued successfully.', id: this.lastID });
        }
    );
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Lesson Notify Backend running on port ${PORT}`);
});