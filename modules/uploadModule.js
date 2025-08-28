// // import express from 'express';
// // import fs from 'fs';
// // import path from 'path';
// // import multer from 'multer';
// // import cors from 'cors';

// require('dotenv').config();
// const express = require('express');
// const fs = require('fs');
// const path = require('path');
// const multer = require('multer');
// const cors = require('cors');

// const app = express();
// const PORT = 5000;

// app.use(cors());
// app.use(express.json());

// const UPLOAD_DIR = path.join(__dirname, 'uploads');
// if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// // For storing each chunk
// const storage = multer.diskStorage({
//     destination: (req, file, cb) => {
//         const fileId = req.query.fileId; // use query instead of req.body
//         const chunkDir = path.join(UPLOAD_DIR, fileId);
//         if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });
//         cb(null, chunkDir);
//     },
//     filename: (req, file, cb) => {
//         cb(null, `chunk_${req.query.chunkIndex}`); // also use query
//     }
// });

// const upload = multer({ storage });

// // Upload a single chunk
// app.post('/upload', upload.single('chunk'), (req, res) => {
//     res.status(200).json({ message: 'Chunk uploaded' });
// });

// // Merge all chunks after upload
// app.post('/merge', async (req, res) => {
//     const { fileName, fileId, totalChunks } = req.body;
//     const chunkDir = path.join(UPLOAD_DIR, fileId);
//     const finalPath = path.join(UPLOAD_DIR, fileName);

//     const writeStream = fs.createWriteStream(finalPath);
//     for (let i = 0; i < totalChunks; i++) {
//         const chunkPath = path.join(chunkDir, `chunk_${i}`);
//         const data = fs.readFileSync(chunkPath);
//         writeStream.write(data);
//         fs.unlinkSync(chunkPath); // delete chunk after writing
//     }

//     writeStream.end();
//     writeStream.on('finish', () => {
//         fs.rmdirSync(chunkDir); // remove chunk folder
//         res.status(200).json({ message: 'File merged successfully' });
//     });
// });

// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import cors from 'cors';

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// For storing each chunk
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const fileId = req.query.fileId; // use query instead of req.body
        const chunkDir = path.join(UPLOAD_DIR, fileId);
        if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });
        cb(null, chunkDir);
    },
    filename: (req, file, cb) => {
        cb(null, `chunk_${req.query.chunkIndex}`); // also use query
    }
});

const upload = multer({ storage });

// Upload a single chunk
app.post('/upload', upload.single('chunk'), (req, res) => {
    res.status(200).json({ message: 'Chunk uploaded' });
});

// Merge all chunks after upload
app.post('/merge', async (req, res) => {
    const { fileName, fileId, totalChunks } = req.body;
    const chunkDir = path.join(UPLOAD_DIR, fileId);
    const finalPath = path.join(UPLOAD_DIR, fileName);

    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk_${i}`);
        const data = fs.readFileSync(chunkPath);
        writeStream.write(data);
        fs.unlinkSync(chunkPath); // delete chunk after writing
    }

    writeStream.end();
    writeStream.on('finish', () => {
        fs.rmdirSync(chunkDir); // remove chunk folder
        res.status(200).json({ message: 'File merged successfully' });
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));