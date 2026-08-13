require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const webpush = require('web-push');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@lessonnotify.app',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
} else {
    console.warn('⚠️  VAPID keys not set — push notifications skipped, only the SMS simulator will run.');
}

let lastNotifiedMinute = "";

async function sendSMS(phoneNumber, messageContent) {
    try {
        console.log(`\n📡 [LOCAL GATEWAY SIMULATOR] Connecting to cellular tower subnet...`);
        console.log(`Forwarding payload packet to subscriber line: ${phoneNumber}`);

        await new Promise(resolve => setTimeout(resolve, 1000));

        const successTimestamp = new Date().toISOString();
        const logEntry = `[${successTimestamp}] To: ${phoneNumber} | Msg: ${messageContent}\n`;
        fs.appendFileSync('sms_outbox.txt', logEntry);

        console.log(`✅ SMS Delivered Successfully! Status Code: 200 | Log saved to sms_outbox.txt`);
        console.log(`========================================================================\n`);
    } catch (error) {
        console.error("Simulator failure:", error.message);
    }
}

async function sendPushAlert(teacherId, payload) {
    if (!pushEnabled) return;

    const { data: subs, error } = await supabase.from('push_subscriptions')
        .select('id, endpoint, p256dh, auth').eq('user_id', teacherId);
    if (error || !subs || subs.length === 0) return;

    for (const sub of subs) {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                JSON.stringify(payload)
            );
            console.log(`🔔 [PUSH] Delivered to subscription #${sub.id}`);
        } catch (err) {
            console.error(`🔔 [PUSH] Failed for subscription #${sub.id}:`, err.message);
            if (err.statusCode === 410 || err.statusCode === 404) {
                await supabase.from('push_subscriptions').delete().eq('id', sub.id);
            }
        }
    }
}

async function scanTimetable() {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = days[new Date().getDay()];

    const futureTime = new Date(Date.now() + 15 * 60 * 1000);
    const hours = String(futureTime.getHours()).padStart(2, '0');
    const minutes = String(futureTime.getMinutes()).padStart(2, '0');
    const targetStartTime = `${hours}:${minutes}:00`;

    const currentMinuteStamp = `${currentDay}-${hours}:${minutes}`;

    if (lastNotifiedMinute === currentMinuteStamp) {
        return;
    }

    console.log(`\n--- [CLOCK TRIGGER] Scanning database for upcoming periods ---`);
    console.log(`Current Day: ${currentDay} | Looking for classes starting at: ${targetStartTime}`);

    const { data: upcomingPeriods, error: periodError } = await supabase
        .from('periods')
        .select('subject_name, classroom_or_hall, start_time, teacher_id')
        .eq('day_of_week', currentDay)
        .eq('start_time', targetStartTime);

    if (periodError) {
        console.error("Error reading timetable:", periodError.message);
        return;
    }

    if (upcomingPeriods.length === 0) {
        console.log("No classes starting in 15 minutes. Standing by...");
        return;
    }

    for (const period of upcomingPeriods) {
        const { data: teacher, error: teacherError } = await supabase
            .from('users')
            .select('id, name, phone_number')
            .eq('id', period.teacher_id)
            .single();

        if (teacherError) {
            console.error("Could not find teacher for this class:", teacherError.message);
            continue;
        }

        const alertMessage = `ALERT: Hello ${teacher.name}, your "${period.subject_name}" class in ${period.classroom_or_hall} starts in 15 minutes (${period.start_time}). - Lesson Notify`;

        console.log("\n========================================================");
        console.log("🚀 [TRIGGER ENGINE] MATCH FOUND! DISPATCHING ALERTS:");
        console.log(`To: ${teacher.phone_number} (SMS) / user #${teacher.id} (push)`);
        console.log(`Message: ${alertMessage}`);
        console.log("========================================================\n");

        await sendSMS(teacher.phone_number, alertMessage);
        await sendPushAlert(teacher.id, {
            title: '⏰ Class starting soon',
            body: `${period.subject_name} in ${period.classroom_or_hall} starts in 15 minutes.`
        });
    }

    lastNotifiedMinute = currentMinuteStamp;
}

console.log("Lesson Notify Engine Activated with SMS Simulator + Real Push Notifications...");
setInterval(scanTimetable, 10000);