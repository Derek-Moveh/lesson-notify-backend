require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function forceSetupAndTest() {
    console.log("Connecting to Supabase cloud to build and test table directly...");

    // 1. Tell Supabase to create the table and insert data via SQL execute simulation
    // We send an RPC or standard API request to force insert. 
    // Since we are using the public client, we will directly attempt to insert the user.
    console.log("Attempting to insert test user...");
    
    const { error: insertError } = await supabase
        .from('users')
        .insert([
            { 
                id: 1, 
                institution_id: 1, 
                name: 'Mr. Emeka (Python Instructor)', 
                email: 'emeka@deltatech.com', 
                phone_number: '2348022222222', 
                role: 'teacher' 
            }
        ]);

    // 2. Read the table back to verify
    console.log("Reading data back from users table...");
    const { data, error: readError } = await supabase
        .from('users')
        .select('*');

    if (readError) {
        console.error("❌ Read Error! The table likely does not exist yet. Error message:", readError.message);
        return;
    }

    console.log("✅ Success! Here is the data currently inside your cloud table:\n", data);
}

forceSetupAndTest();
