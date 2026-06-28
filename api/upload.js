import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function chunkText(text, size = 500) {
  const words = text.split(' ');
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(' '));
  }
  return chunks;
}

async function getEmbedding(text) {
  const response = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`
    },
    body: JSON.stringify({
      input: [text],
      model: 'jina-embeddings-v2-base-en'
    })
  });
  const data = await response.json();
  return data.data[0].embedding;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Password check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const form = formidable({ maxFileSize: 10 * 1024 * 1024 });
  const [fields, files] = await form.parse(req);

  const file = files.pdf[0];
  const title = fields.title[0];
  const buffer = fs.readFileSync(file.filepath);
  const pdf = await pdfParse(buffer);
  const text = pdf.text;

  // Save paper to database
  const { data: paper, error } = await supabase
    .from('papers')
    .insert({ title, filename: file.originalFilename })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Chunk and embed
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbedding(chunks[i]);
    await supabase.from('paper_chunks').insert({
      paper_id: paper.id,
      content: chunks[i],
      embedding,
      chunk_index: i
    });
  }

  res.status(200).json({ success: true, paperId: paper.id, chunks: chunks.length });
}
