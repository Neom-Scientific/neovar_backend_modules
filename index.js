const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const ftp = require('basic-ftp');
const { Readable, Writable } = require('stream'); // Add Writable here
const db = require('./config');
const archiver = require('archiver');
require('dotenv').config();
const nodemailer = require('nodemailer');
const axios = require('axios');
const qs = require("querystring");



const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
    origin: '*', // or '*', but best to specify
    credentials: true
}));
app.use(express.json());

const storage = multer.memoryStorage(); // <-- use memory storage
const upload = multer({ storage });


async function upsertProject({ projectName, inputDir, progress, email, numberOfSamples, testName, starttime, sessionId, vcfFilePath, script_path }) {
    // const projectid = await createProjectId(email);
    let projectId;
    // console.log('vcfFilePath:', vcfFilePath)
    let counterValue = 0;
    if (typeof numberOfSamples === 'number' && Number.isFinite(numberOfSamples)) {
        counterValue = numberOfSamples;
    } else if (typeof numberOfSamples === 'string' && numberOfSamples.trim() !== '' && !isNaN(Number(numberOfSamples))) {
        counterValue = Number(numberOfSamples);
    }
    // Ensure progress is always an integer
    let progressValue = 0;
    if (typeof progress === 'number' && Number.isFinite(progress)) {
        progressValue = progress;
    } else if (typeof progress === 'string' && progress.trim() !== '' && !isNaN(Number(progress))) {
        progressValue = Number(progress);
    }
    // Try to update first
    const updateRes = await db.query(
        `UPDATE runningtasks
         SET inputdir = $1, progress = $2, numberofsamples = $3, testtype = $4,vcf_file_path = $7
         WHERE projectname = $5 AND email = $6`,
        [inputDir, progressValue, counterValue, testName || '', projectName, email || '', vcfFilePath || []]
    );
    if (updateRes.rowCount === 0) {
        projectId = await createProjectId(email);
        // console.log('projectId:', projectId)
        await db.query(
            `INSERT INTO runningtasks 
                (projectid, projectname, inputdir, testtype, email, progress, numberofsamples, starttime, session_id,script_path) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,$10)
             ON CONFLICT (projectid) DO NOTHING`,
            [
                projectId,
                projectName,
                inputDir,
                testName,
                email || '',
                progressValue,
                counterValue,
                starttime,
                sessionId,
                script_path || ''
            ]
        );
    }
}
async function uploadChunkViaFTPBuffer(buffer, remoteFilePath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    try {
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: true,
            secureOptions: { rejectUnauthorized: false },
            passive: true,
        });

        const remoteDir = path.dirname(remoteFilePath);
        await client.ensureDir(remoteDir);

        // Convert buffer to stream for FTP upload
        const stream = Readable.from(buffer);
        await client.uploadFrom(stream, remoteFilePath);

        // console.log(`Uploaded chunk to FTP: ${remoteFilePath}`);
    } catch (err) {
        console.error('FTP upload error:', err);
        throw err;
    } finally {
        client.close();
    }
}

app.get('/start-project', async (req, res) => {
    const { email, numberofsamples } = req.query;
    try {
        const { rows } = await db.query('SELECT * FROM runningtasks WHERE email = $1', [email]);
        if (rows.length > 0) {
            return res.json({ message: 'A project is already running with this email', status: 400 });
        }
        const { rows: request_form } = await db.query('SELECT * FROM request_form where email = $1', [email]);
        let counters = request_form[0].neovar_counters;
        counters = counters - numberofsamples;
        if (counters < 0) {
            return res.json({ message: 'You have insufficient counters to start a new project', status: 400 });
        }
        else {
            await db.query('UPDATE request_form SET neovar_counters = $1 WHERE email = $2', [counters, email]);
        }
        // Optionally, create the project here
        res.json({ message: 'OK to start upload', status: 200 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload chunk endpoint
app.post('/upload', upload.single('chunk'), async (req, res) => {
    const { projectName, sessionId, chunkIndex, fileName, email, numberofsamples, processingMode, relativePath = '' } = req.query;
    const remoteFilePath = path.posix.join('/neovar', sessionId, 'inputDir', 'chunks', fileName, `chunk_${chunkIndex}`);
    const client = new ftp.Client(6000000);
    try {
        const response = [];
        let script_path = '';
        await uploadChunkViaFTPBuffer(req.file.buffer, remoteFilePath);
        if (processingMode === 'quantum_mode') {
            script_path = '/opt/scrips/process_session_quantum.sh'
        }
        else if (processingMode === 'hyper_mode') {
            script_path = '/home/manas/Secondary-Analysis/sentieon/neovar_script/process_session_hyper.sh'
        }
        // Now update metadata
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: true,
            secureOptions: { rejectUnauthorized: false },
            passive: true,
        });

        await upsertProject({
            projectName: projectName,
            inputDir: `/neovar/${sessionId}/inputDir`,
            progress: 0,
            email: email,
            testName: '',
            starttime: Date.now(),
            sessionId: sessionId,
            script_path: script_path
        });
        res.json({ message: 'Chunk uploaded and metadata updated', status: 200 });
    } catch (err) {
        if (err.message.includes('A project is already running')) {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ error: err.message });
    } finally {
        client.close();
    }
});


app.post('/merge', async (req, res) => {
    const { sessionId, fileNames, testName, numberOfSamples, email, projectName } = req.body;
    const client = new ftp.Client();
    try {
        const response = [];

        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: true,
            secureOptions: { rejectUnauthorized: false },
            passive: true,
        });

        let vcfFilePath = [];
        const seenBaseNames = new Set();
        for (const fileName of fileNames) {
            const triggerFilePath = path.posix.join('/neovar', 'triggers', `${sessionId}_${fileName}.flag`);
            const flagContent = `${fileName}\n${testName || ''}`;
            // Remove all extensions (.gz, .fastq, etc.)
            let baseName = fileName.replace(/\.(fastq|fq|gz|bz2|zip)$/gi, '');
            baseName = baseName.replace(/\.(fastq|fq|gz|bz2|zip)$/gi, '');
            // Remove trailing _R and digit(s)
            baseName = baseName.replace(/_R\d+$/, '_R');
            if (!seenBaseNames.has(baseName)) {
                vcfFilePath.push(`/neovar/${sessionId}/${sessionId}/${baseName}/${baseName}_filtered.vcf.gz`);
                seenBaseNames.add(baseName);
            }
            await client.uploadFrom(Readable.from(flagContent), triggerFilePath);
        }

        // Update metadata in DB
        await upsertProject({
            projectName: projectName,
            progress: 0,
            email: email || '',
            numberOfSamples: numberOfSamples || '',
            testName: testName || '',
            sessionId: sessionId,
            vcfFilePath: vcfFilePath,
        });

        res.status(200).json({ message: 'Merge triggered and metadata updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.close();
    }
});

app.get('/progress', async (req, res) => {
    const { sessionId, email } = req.query;
    try {
        const response = [];
        if (!sessionId || !email) {
            response.push({
                message: 'Missing sessionId or email',
                status: 400
            })
            return res.json(response);
        }
        const result = await db.query('SELECT * FROM runningtasks WHERE session_id = $1 AND email = $2', [sessionId, email]);
        if (result.rowCount === 0) {
            response.push({
                message: 'Session or email not found',
                status: 404
            })
            return res.json(response);
        }
        const rows = result.rows;
        const progress = rows[0].progress;
        if (progress === 100) {
            const {
                projectid: projectId,
                projectname: projectName,
                inputdir: inputDir,
                numberofsamples: counterValue,
                testtype: testName,
                email,
                starttime,
                session_id: sessionId,
                vcf_file_path: vcf_file_path
            } = rows[0];
            await db.query('DELETE FROM runningtasks WHERE projectname = $1 AND email = $2', [projectName, email]);
            await db.query(
                'INSERT INTO CounterTasks (projectname,  email, numberofsamples, creationtime,session_id, vcf_file_path,projectid ) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
                [
                    projectName,
                    email || '',
                    counterValue,
                    starttime,
                    sessionId,
                    vcf_file_path || [],
                    projectId
                ]
            );
        }
        res.json({ rows });
    } catch (err) {
        console.error('Error in fetching progress from DB:', err);
        res.status(500).json({ error: 'Error in fetching progress' });
    }
});

app.get('/read-counter-json', async (req, res) => {
    const email = req.query.email;
    try {
        const response = [];
        if (!email) {
            response.push({
                message: 'Email parameter is required',
                status: 400
            })
            return res.json(response);
        }
        const counterData = await db.query('SELECT * FROM CounterTasks WHERE email = $1 ORDER BY projectid DESC', [email]);
        if (counterData.rowCount === 0) {
            response.push({
                message: 'No project found for the provided email',
                status: 404
            })
            return res.json(response);
        }
        return res.json(counterData.rows);
    } catch (err) {
        console.error('Error in fetching the counter data:', err);
        return res.status(500).json({ error: 'Error in fetching the counter data' });
    }
});


app.get('/download-vcf', async (req, res) => {
    const { projectId, email } = req.query;
    if (!projectId || !email) {
        return res.status(400).json({ error: 'Missing projectId or email' });
    }
    try {
        const response = [];
        const result = await db.query(
            'SELECT vcf_file_path FROM countertasks WHERE projectid = $1 AND email = $2',
            [projectId, email]
        );
        // console.log('projectId:', projectId, 'email:', email);
        if (result.rowCount === 0) {
            response.push({
                message: 'Project not found',
                status: 404
            })
            return res.json(response);
        }
        let vcfPaths = result.rows[0].vcf_file_path;
        if (!Array.isArray(vcfPaths)) vcfPaths = [vcfPaths];
        if (!vcfPaths || vcfPaths.length === 0) {
            response.push({
                message: 'VCF file path not found',
                status: 404
            })
            return res.json(response);
        }
        // console.log('client connected');
        // console.log('vcfPaths:', vcfPaths);
        const client = new ftp.Client();
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASS,
            secure: true,
            secureOptions: { rejectUnauthorized: false },
            passive: true,
        });

        res.setHeader('Content-Disposition', `attachment; filename="vcf_files.zip"`);
        res.setHeader('Content-Type', 'application/zip');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('finish', () => {
            client.close();
            // Optionally log success
        });
        archive.on('error', err => {
            console.error('Archive error:', err);
            res.status(500).end();
            client.close();
        });
        archive.pipe(res);

        for (const filePath of vcfPaths) {
            const fileName = path.basename(filePath);
            const passThrough = new require('stream').PassThrough();
            archive.append(passThrough, { name: fileName });
            await client.downloadTo(passThrough, filePath);
        }

        archive.finalize();
    } catch (err) {
        console.error('Error downloading VCFs:', err);
        res.status(500).json({ error: 'Error downloading VCF files' });
    }
});

app.post('/send-help-query', async (req, res) => {
    const { name, email, subject, message } = req.body;
    try {
        const response = [];
        if (!name || !email || !subject || !message) {
            response.push({
                message: 'All fields (name, email, subject, message) are required',
                status: 400
            })
            return res.json(response);
        }
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.ADMIN_EMAIL,
                pass: process.env.APP_PASSWORD,
            }
        });

        const mailOptions = {
            from: email,
            to: process.env.ADMIN_EMAIL,
            subject: `Help Query: ${subject}`,
            html: `
            <h3>Query came from Neovar User ${name}</h3>
            <p>${message}</p>
            <p>Reply to: ${email}</p>
            `
        };

        await transporter.sendMail(mailOptions);
        res.json({
            message: 'Your query has been sent successfully. We will get back to you soon.',
            status: 200
        });
    }
    catch (err) {
        console.error('Error in sending help query:', err);
        return res.json({ message: 'Error in sending help query', status: 500 });
    }
});


// app.get('/download-vcf', async (req, res) => {
//     const { projectId, email } = req.query;
//     if (!projectId || !email) {
//         return res.status(400).json({ error: 'Missing projectId or email' });
//     }
//     let client;
//     try {
//         const result = await db.query(
//             'SELECT session_id FROM countertasks WHERE projectid = $1 AND email = $2',
//             [projectId, email]
//         );
//         if (result.rowCount === 0) {
//             return res.status(404).json({ error: 'Project not found' });
//         }
//         const sessionId = result.rows[0].session_id;
//         if (!sessionId) {
//             return res.status(404).json({ error: 'Session ID not found' });
//         }

//         client = new ftp.Client(0); // No timeout
//         client.ftp.verbose = false;

//         await client.access({
//             host: process.env.FTP_HOST,
//             user: process.env.FTP_USER,
//             password: process.env.FTP_PASS,
//             secure: true,
//             secureOptions: { rejectUnauthorized: false },
//             passive: true,
//         });

//         const rootDir = `/neovar/${sessionId}/${sessionId}`;

//         res.setHeader('Content-Disposition', `attachment; filename="${sessionId}_all_files.zip"`);
//         res.setHeader('Content-Type', 'application/zip');

//         const archive = archiver('zip', { zlib: { level: 9 } });
//         archive.on('error', err => {
//             console.error('Archive error:', err);
//             res.end();
//         });
//         archive.pipe(res);

//         async function addFtpFolderToArchive(ftpClient, remoteDir, archive, baseDir = '') {
//             const list = await ftpClient.list(remoteDir);
//             for (const item of list) {
//                 const remotePath = path.posix.join(remoteDir, item.name);
//                 const archivePath = path.posix.join(baseDir, item.name);
//                 if (item.isDirectory) {
//                     await addFtpFolderToArchive(ftpClient, remotePath, archive, archivePath);
//                 } else {
//                     const passThrough = new require('stream').PassThrough();
//                     archive.append(passThrough, { name: archivePath });
//                     await ftpClient.downloadTo(passThrough, remotePath);
//                 }
//             }
//         }

//         await addFtpFolderToArchive(client, rootDir, archive);

//         archive.finalize();
//         client.close();
//     } catch (err) {
//         console.error('Error downloading folder:', err);
//         if (!res.headersSent) {
//             res.status(500).json({ error: 'Error downloading folder' });
//         }
//         if (client) client.close();
//     }
// });

async function createProjectId(email) {
    let projectId;

    // Fetch all project IDs for the user
    const { rows: existingRows } = await db.query('SELECT projectid FROM countertasks WHERE email = $1', [email]);
    let maxCounter = 0;

    // Regex to extract the counter from projectid (PRJ-yyyymmdd-XX)
    const counterRegex = /^PRJ-\d{8}-(\d+)$/;

    for (const row of existingRows) {
        const match = counterRegex.exec(row.projectid);
        if (match) {
            const counter = parseInt(match[1], 10);
            if (counter > maxCounter) {
                maxCounter = counter;
            }
        }
    }

    // Get today's date in yyyymmdd format
    const today = new Date();
    const yyyymmdd = today.getFullYear().toString() +
        String(today.getMonth() + 1).padStart(2, '0') +
        String(today.getDate()).padStart(2, '0');

    // Increment the max counter for the new project
    const newCounter = maxCounter + 1;

    projectId = `PRJ-${yyyymmdd}-${String(newCounter).padStart(2, '0')}`;
    return projectId;
}


app.post('/create-syno-share', async (req, res) => {
    const { email, project_id } = req.body;
    try {
        const responsesend = [];
        const {rows}=await db.query('SELECT session_id FROM countertasks WHERE projectid=$1 AND email=$2',[project_id,email]);
        if(rows.length===0){
            responsesend.push({
                message: 'No project found for the provided email and project_id',
                status: 404
            })
            return res.json(responsesend);
        }
        const path = `/neovar/${rows[0].session_id}/${rows[0].session_id}`;
        let sid = await axios.post('https://192.168.1.50:5001/webapi/auth.cgi?api=SYNO.API.Auth&method=login&version=6&account=neom&passwd=Syno%40ds1821&session=FileStation&format=sid',{},{httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })})
        sid = sid.data.data.sid;
        // console.log('sid:',sid);
        const expire_days = 7; // Link expires in 7 days
        const synoUrl = 'https://192.168.1.50:5001/webapi/entry.cgi';
        const params = new URLSearchParams();
        params.append('api', 'SYNO.FileStation.Sharing');
        params.append('version', '3');
        params.append('method', 'create');
        params.append('path', path);
        params.append('expire_days', expire_days);
        params.append('_sid', sid);

        const response = await axios.post(synoUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) // Ignore self-signed certs
        });
        // const postData = qs.stringify({
        //     api: "SYNO.FileStation.Sharing",
        //     version: "3",
        //     method: "create",
        //     path: `/neovar/${rows[0].session_id}/${rows[0].session_id}`,
        //     expire_days: 7,
        //     _sid: sid
        //   });
        //   console.log('postData:',postData);
          
        //   const response = await axios.post(
        //     "https://192.168.1.50:5001/webapi/entry.cgi",
        //     postData,
        //     {
        //       headers: { "Content-Type": "application/x-www-form-urlencoded" },
        //       httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false })
        //     }
        //   );

        res.json(response.data);
    } catch (err) {
        console.error('Error creating Synology share:', err);
        res.status(500).json({ error: 'Failed to create Synology share', details: err.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// increase timeout to 24hours
server.timeout = 24 * 60 * 60 * 1000; // 24 hours

// curl -k -X POST "https://192.168.1.50:5001/webapi/entry.cgi" \
// -d "api=SYNO.FileStation.Sharing" \
// -d "version=3" \
// -d "method=create" \
// -d "path=/neovar/02-09-2025--09-37-22-pkprateekkhatri@gmail.com" \
// -d "expire_days=7" \
// -d "_sid=gPgWoZjLcUl2rr3Uxa5l07WEz734hmBgBzowHNUpDaoRLQP4FodQUSTE812Twyi_B-i4M8EtBQmGtJ-CV-Td1M"
{/*
    {"data":{"has_folder":true,"links":[{"app":{"enable_upload":false,"is_folder":true},"date_available":"","date_expired":"","enable_upload":false,"expire_times":0,"has_password":false,"id":"XkhKChlUD","isFolder":true,"limit_size":0,"link_owner":"NEOM","name":"02-09-2025--09-37-22-pkprateekkhatri@gmail.com","path":"/neovar/02-09-2025--09-37-22-pkprateekkhatri@gmail.com","project_name":"SYNO.SDS.App.FileStation3.Instance","protect_groups":[],"protect_type":"none","protect_users":[],"qrcode":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHsAAAB7AQMAAABuCW08AAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAFwSURBVEiJ1dW9rcQgDABgRxR0dwsgsQYdK4UFLskCyUruWAOJBaCjQPj53un0fooXX3PSQymSTwo4BjtAvwb8ZygAS7M1moAwyaBSD2hmSEvkexkgv62KSyFCkEOkrcH1FZi9IuwvwD1S/ixe9lvofwLnI3AyfiToBHgMZ4s24WsbziAm8HREtTq4ymB42igPMBdIQQbU+sQX5tXZKoPh1NHscLQ6nkwE1Ax4E1oKSFUGFW3FvkR1YA8yGK7ftB1Au05CKDpvsYPjvcqHDCh2TvY9hTpNMqjIiQdwedfP0M9gaJidAci7T0KoLRefd2euLW9CQLh4M0V7IB0yGJr3h6dRFZ9xnEFxhucAnwAex+EciOyGfSLLIR8yKI4j5bdtAVVlwKMAFxw/SeFe2Q1mze3QCuGzf9jVccrVJgQ0S8zElc2tVw6NC4hrzgQxzC4XzWvaTQjUF+Rzp7gsSAacjxvk2vqsHx33HN7z43sHfAAnmGD+1H8f/wAAAABJRU5ErkJggg==","request_info":"","request_name":"","status":"valid","uid":1026,"url":"https://gofile
    */}
// strive@strive:/media/strive/Strive/prateek/neovar_modules$ curl -k -X POST "https://192.168.1.50:5001/webapi/entry.cgi" -d "api=SYNO.FileStation.Sharing" -d "version=3" -d "method=create" -d "path=/neovar/02-09-2025--09-37-22-pkprateekkhatri@gmail.com" -d "expire_days=7" -d "_sid=gPgWoZjLcUl2rr3Uxa5l07WEz734hmBgBzowHNUpDaoRLQP4FodQUSTE812Twyi_B-i4M8EtBQmGtJ-CV-Td1M"
{/*
    {"data":{"has_folder":true,"links":[{"app":{"enable_upload":false,"is_folder":true},"date_available":"","date_expired":"","enable_upload":false,"expire_times":0,"has_password":false,"id":"jS9cwUGKj","isFolder":true,"limit_size":0,"link_owner":"NEOM","name":"02-09-2025--09-37-22-pkprateekkhatri@gmail.com","path":"/neovar/02-09-2025--09-37-22-pkprateekkhatri@gmail.com","project_name":"SYNO.SDS.App.FileStation3.Instance","protect_groups":[],"protect_type":"none","protect_users":[],"qrcode":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHsAAAB7AQMAAABuCW08AAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAFzSURBVEiJ1dU9bsMgFAfwZ3lgiy+AxDW8cSX7Aia+QHwlNq6BxAXMxoD8+qeNmqhD/CJ1aJGH+CcFwfsy8Y9F/xl2IhdoIV49dTLIXF0w2dMQ8FsGXi8qdl4PgeY3AHvU7h2YQ1o5ZTm0k2oXAE9HfwmIxxx0ex4BOgGsXNKhqnuk4Qx8JYubpZsyQthHXkvaCl9VykKwOCO2SRvXTgZcEnuzIerFZBkcFCdlDtVf2zYiyL5fAx82cYlOBvtYO1+H0u9jYimYm9JTK/A4yOCwkdoxe3TDLARCivTFxgEVIYMc4qL6DW1ntZMBor6PcSgVnbrJYFcaKdoRQr7f9hwIhYOeQ/juFXQKzHVR2vm03i93DodFepGoSmPPMsDbzAYhn8hsMmg9x3qy6FHDMmidXdJn6ZGTQZsf+K/nlR/j8wTaYNNEePpNDBg2LqDnsI0UJswbj85LLIQ2C3sMqqt9Go4v4evrgXUZvwN0Ar/xWfsb8AGcqHfzcPo7zQAAAABJRU5ErkJggg==","request_info":"","request_name":"","status":"valid","uid":1026,"url":"https://gofile.me/7G23n/jS9cwUGKj"}]},"success":true}
    
    */}