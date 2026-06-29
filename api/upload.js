import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = req.headers.authorization;
  const token = auth?.replace('Bearer ', '');

// Accept either admin password or a valid professor ID (UUID format)
  const isAdminPassword = token === process.env.ADMIN_PASSWORD;
  const isValidProfessor = token && token.length === 36 && token.includes('-');

  if (!isAdminPassword && !isValidProfessor) {
    return res.status(401).json({ error: 'Unauthorized' });
}

  try {
    const form = formidable({ maxFileSize: 10 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const file = files.pdf[0];
    const title = fields.title[0];
    const description = fields.description?.[0] || '';
    const enableContext = fields.enableContext?.[0] === 'true';
    const quickQuestions = JSON.parse(fields.quickQuestions?.[0] || '[]');
    const professorId = fields.professorId?.[0] || null;
    const profName = fields.profName?.[0] || '';
    const institution = fields.institution?.[0] || '';

    // Step 1: Parse PDF and extract text
    const buffer = fs.readFileSync(file.filepath);
    const pdf = await pdfParse(buffer);
    const text = pdf.text;

    // Step 2: Create paper record immediately
    const { data: paper, error } = await supabase
      .from('papers')
      .insert({
        title,
        filename: file.originalFilename,
        description,
        enable_context: enableContext,
        quick_questions: quickQuestions,
        processed: false,
        professor_name: profName,
        institution: institution,
        professor_id: professorId
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Step 3: Return link immediately to professor
    res.status(200).json({
      success: true,
      paperId: paper.id,
      chatLink: `/chat?id=${paper.id}`,
      message: 'Paper uploaded! Chatbot link is ready. Processing chunks in background...'
    });

    // Step 4: Trigger Edge Function in background (fire and forget)
    const edgeFunctionUrl = `${process.env.SUPABASE_URL}/functions/v1/process-chunks`;

    fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        paperId: paper.id,
        text
      })
    }).catch(err => console.error('Edge function error:', err));

  } catch (err) {
    console.error('Upload error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Upload failed', detail: err.message });
    }
  }
}
