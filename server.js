const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const mime = require('mime-types');
const { YoutubeTranscript } = require('youtube-transcript');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const TEMP_DIR = path.join(ROOT_DIR, 'tmp');
const UPLOAD_DIR = path.join(TEMP_DIR, 'uploads');
const WORK_DIR = path.join(TEMP_DIR, 'work');
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

const DEFAULT_MAN_VIDEO_URL = process.env.DEFAULT_MAN_VIDEO_URL || 'https://YOUR_DEFAULT_MAN_VIDEO_URL/man-default.mp4';
const DEFAULT_WOMAN_VIDEO_URL = process.env.DEFAULT_WOMAN_VIDEO_URL || 'https://YOUR_DEFAULT_MAN_VIDEO_URL/woman-default.mp4';

const VIDEO_LIBRARY = {
  man: {
    studio: 'https://YOUR_DEFAULT_MAN_VIDEO_URL/library/man-studio.mp4',
    office: 'https://YOUR_DEFAULT_MAN_VIDEO_URL/library/man-office.mp4'
  },
  woman: {
    studio: 'https://YOUR_DEFAULT_MAN_VIDEO_URL/library/woman-studio.mp4',
    office: 'https://YOUR_DEFAULT_MAN_VIDEO_URL/library/woman-office.mp4'
  }
};

async function ensureDirectories() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

ensureDirectories().catch((err) => {
  console.error('Failed to prepare directories', err);
  process.exit(1);
});

app.use(express.static(ROOT_DIR));
app.use('/downloads', express.static(OUTPUT_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

function sanitizeFileName(name) {
  return name.replace(/[^a-z0-9-_\.]/gi, '_');
}

async function cleanupFiles(filePaths) {
  await Promise.all(
    filePaths.map(async (filePath) => {
      if (!filePath) return;
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn('Failed to clean up file', filePath, err.message);
        }
      }
    })
  );
}

async function readFileAsBase64(filePath) {
  const buffer = await fsp.readFile(filePath);
  return buffer.toString('base64');
}

async function downloadFile(url, targetPath) {
  const writer = fs.createWriteStream(targetPath);
  const response = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on('error', (err) => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on('close', () => {
      if (!error) {
        resolve();
      }
    });
  });
  return targetPath;
}

async function extractYouTubeTranscript(url) {
  try {
    const items = await YoutubeTranscript.fetchTranscript(url);
    if (!items || !items.length) {
      return null;
    }
    return items.map((item) => item.text).join(' ');
  } catch (err) {
    console.warn('Failed to fetch YouTube transcript:', err.message);
    return null;
  }
}

async function prepareTopicParts({ topicText, youtubeUrl, topicFilePath, podcastLength }) {
  const parts = [];
  const intro = `You are a podcast creator. Generate an engaging, interesting, and detailed conversation script between a "Man" and a "Woman" about the provided topic. The conversation should be unique and last for approximately ${podcastLength} minutes. Format the output as a JSON array like [{ "speaker": "Man", "line": "..." }, { "speaker": "Woman", "line": "..." }].`;
  parts.push({ text: intro });

  if (topicText) {
    parts.push({ text: `Plain text topic provided by the user: ${topicText}` });
  }

  if (youtubeUrl) {
    const transcriptText = await extractYouTubeTranscript(youtubeUrl);
    if (transcriptText) {
      parts.push({ text: `YouTube transcript extracted from ${youtubeUrl}: ${transcriptText}` });
    } else {
      parts.push({ text: `A YouTube URL was provided (${youtubeUrl}) but no transcript could be extracted. Base the conversation on the rest of the supplied materials.` });
    }
  }

  if (topicFilePath) {
    const mimeType = mime.lookup(topicFilePath) || 'application/octet-stream';
    const base64Data = await readFileAsBase64(topicFilePath);
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
  }

  if (parts.length === 1) {
    parts.push({ text: 'No additional context was provided. Create an original conversation based on your own knowledge.' });
  }

  return parts;
}

async function callGemini(apiKey, parts) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`;
  const response = await axios.post(endpoint, {
    contents: [
      {
        role: 'user',
        parts
      }
    ]
  });

  const candidates = response.data?.candidates;
  if (!candidates || !candidates.length) {
    throw new Error('Gemini returned no candidates.');
  }

  const textPart = candidates[0]?.content?.parts?.find((part) => part.text);
  if (!textPart || !textPart.text) {
    throw new Error('Gemini response did not include text content.');
  }

  let script;
  try {
    script = JSON.parse(textPart.text);
  } catch (err) {
    throw new Error('Failed to parse Gemini response as JSON. Ensure the model is instructed to output valid JSON.');
  }

  if (!Array.isArray(script)) {
    throw new Error('Gemini response JSON is not an array.');
  }

  return script;
}

async function synthesizeSpeech(apiKey, text, languageCode, voiceName, outputPath) {
  const endpoint = `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${apiKey}`;
  const payload = {
    input: { text },
    voice: {
      languageCode,
      name: voiceName,
      model: 'chirp'
    },
    audioConfig: {
      audioEncoding: 'MP3'
    }
  };

  const response = await axios.post(endpoint, payload);
  const audioContent = response.data?.audioContent;
  if (!audioContent) {
    throw new Error('Text-to-Speech response missing audioContent.');
  }

  const buffer = Buffer.from(audioContent, 'base64');
  await fsp.writeFile(outputPath, buffer);
  return outputPath;
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(metadata.format.duration);
    });
  });
}

async function loopVideoWithAudio(videoPath, audioPath, durationSeconds, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .inputOptions(['-stream_loop', '-1'])
      .input(audioPath)
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-shortest',
        `-t ${durationSeconds.toFixed(3)}`,
        '-pix_fmt yuv420p'
      ])
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject);
  });
}

async function concatenateClips(clipPaths, outputPath) {
  const listFilePath = path.join(WORK_DIR, `concat_${uuidv4()}.txt`);
  const listContent = clipPaths.map((clipPath) => `file '${clipPath.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listFilePath, listContent);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });

  await fsp.unlink(listFilePath).catch(() => {});
  return outputPath;
}

async function resolveVideoSource(option, { uploadPath, libraryKey, speaker }) {
  if (option === 'custom') {
    if (!uploadPath) {
      throw new Error(`A custom video was selected for the ${speaker} but no file was uploaded.`);
    }
    return uploadPath;
  }

  const targetFileName = `${speaker}_${uuidv4()}.mp4`;
  const targetPath = path.join(WORK_DIR, targetFileName);

  let sourceUrl;
  if (option === 'library' && libraryKey) {
    sourceUrl = VIDEO_LIBRARY[speaker]?.[libraryKey];
  }
  if (!sourceUrl) {
    sourceUrl = speaker === 'man' ? DEFAULT_MAN_VIDEO_URL : DEFAULT_WOMAN_VIDEO_URL;
  }

  await downloadFile(sourceUrl, targetPath);
  return targetPath;
}

function validateChirpVoice(voiceName) {
  return typeof voiceName === 'string' && voiceName.includes('chirp');
}

const uploadFields = upload.fields([
  { name: 'topicFile', maxCount: 1 },
  { name: 'manVideoFile', maxCount: 1 },
  { name: 'womanVideoFile', maxCount: 1 }
]);

app.post('/generate-podcast', uploadFields, async (req, res) => {
  const cleanupPaths = [];
  try {
    const {
      apiKey,
      topicText,
      youtubeUrl,
      podcastLength = '5',
      languageCode = 'en-US',
      manVoice,
      womanVoice,
      manVideoOption = 'default',
      womanVideoOption = 'default',
      manLibraryVideo,
      womanLibraryVideo
    } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'Google Cloud API key is required.' });
    }

    if (!validateChirpVoice(manVoice) || !validateChirpVoice(womanVoice)) {
      return res.status(400).json({ error: 'Both voices must be selected from the Chirp family.' });
    }

    const topicFile = req.files?.topicFile?.[0];
    const manVideoFile = req.files?.manVideoFile?.[0];
    const womanVideoFile = req.files?.womanVideoFile?.[0];

    const parsedLength = Number.parseFloat(podcastLength);
    const normalizedLength = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 5;

    const topicParts = await prepareTopicParts({
      topicText,
      youtubeUrl,
      topicFilePath: topicFile?.path,
      podcastLength: normalizedLength
    });

    const script = await callGemini(apiKey, topicParts);

    const clipPaths = [];

    const manVideoPath = await resolveVideoSource(manVideoOption, {
      uploadPath: manVideoFile?.path,
      libraryKey: manLibraryVideo,
      speaker: 'man'
    });
    const womanVideoPath = await resolveVideoSource(womanVideoOption, {
      uploadPath: womanVideoFile?.path,
      libraryKey: womanLibraryVideo,
      speaker: 'woman'
    });

    if (manVideoPath !== manVideoFile?.path) {
      cleanupPaths.push(manVideoPath);
    }
    if (womanVideoPath !== womanVideoFile?.path) {
      cleanupPaths.push(womanVideoPath);
    }

    for (let index = 0; index < script.length; index += 1) {
      const line = script[index];
      if (!line || !line.speaker || !line.line) {
        continue;
      }

      const audioFileName = `line_${index + 1}.mp3`;
      const audioPath = path.join(WORK_DIR, `${uuidv4()}_${sanitizeFileName(audioFileName)}`);
      const clipPath = path.join(WORK_DIR, `${uuidv4()}_clip_${index + 1}.mp4`);
      cleanupPaths.push(audioPath, clipPath);

      const voice = line.speaker.toLowerCase().includes('woman') ? womanVoice : manVoice;
      const baseVideoPath = line.speaker.toLowerCase().includes('woman') ? womanVideoPath : manVideoPath;

      // Generate audio sequentially to avoid quota spikes
      // eslint-disable-next-line no-await-in-loop
      await synthesizeSpeech(apiKey, line.line, languageCode, voice, audioPath);
      const duration = await getMediaDuration(audioPath);
      if (!duration || Number.isNaN(duration)) {
        throw new Error('Unable to determine audio duration.');
      }

      // eslint-disable-next-line no-await-in-loop
      await loopVideoWithAudio(baseVideoPath, audioPath, duration, clipPath);
      clipPaths.push(clipPath);
    }

    if (!clipPaths.length) {
      throw new Error('No clips were generated. Check the script returned by Gemini.');
    }

    const podcastId = uuidv4();
    const finalFileName = `podcast_${podcastId}.mp4`;
    const finalOutputPath = path.join(OUTPUT_DIR, finalFileName);
    await concatenateClips(clipPaths, finalOutputPath);

    const downloadUrl = `/downloads/${finalFileName}`;
    res.json({ downloadUrl });

    const tempUploads = [topicFile?.path, manVideoFile?.path, womanVideoFile?.path].filter(Boolean);
    cleanupPaths.push(...tempUploads);
    setTimeout(() => {
      cleanupFiles(cleanupPaths).catch((err) => console.warn('Cleanup error:', err.message));
    }, 30_000);
  } catch (error) {
    console.error('Failed to generate podcast:', error);
    cleanupFiles(cleanupPaths).catch((err) => console.warn('Cleanup error:', err.message));
    res.status(500).json({ error: error.message || 'Failed to generate podcast.' });
  }
});

app.listen(PORT, () => {
  console.log(`Podcast Video Generator backend listening on port ${PORT}`);
});
