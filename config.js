const { Pool } = require('pg');
require('dotenv').config();

const db = new Pool({
    // connectionString:`postgresql://${process.env.NEXT_PUBLIC_DB_USER}:${process.env.NEXT_PUBLIC_DB_PASSWORD}@127.0.0.1:${process.env.NEXT_PUBLIC_DB_PORT}/${process.env.NEXT_PUBLIC_DB_NAME}`,
    connectionString: "postgresql://postgres:Bioinfo@1234@122.160.11.246:5432/vide"
    // connectionString: process.env.NEXT_PUBLIC_DB_URL,
    // user: process.env.NEXT_PUBLIC_DB_USER,
    // host: process.env.NEXT_PUBLIC_DB_HOST,
    // database: process.env.NEXT_PUBLIC_DB_NAME,
    // password: process.env.NEXT_PUBLIC_DB_PASSWORD,
    // port: process.env.NEXT_PUBLIC_DB_PORT
});
db.connect()
    .then(() => console.log("Connected to the database"))
    .catch(err => console.error('Connection error', err.stack));

module.exports = db;