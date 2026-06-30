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
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: prof, error: profError } = await supabase
    .from('professors')
    .select('id')
    .eq('id', token)
    .single();

  if (profError || !prof) {
    return res.status(401).json({ error: 'Invalid professor' });
  }

  try {
    const form = formidable({ maxFileSize: 10 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const file = files.pdf[0];
    const title = fields.title[0];
    const description = fields.description?.[0] || '';
    const enableContext = fields.enableContext?.[0] === 'true';
    const quickQuestions = JSON.parse(fields.quickQuestions?.[0] || '[]');
    const profName = fields.profName?.[0] || '';
    const institution = fields.institution?.[0] || '';

    const buffer = fs.readFileSync(file.filepath);
    const pdf = await pdfParse(buffer);
    const fullText = pdf.text;

    const { data: paper, error } = await supabase
      .from('papers')
      .insert({
        professor_id: token,
        title,
        filename: file.originalFilename,
        description,
        full_text: fullText,
        enable_context: enableContext,
        quick_questions: quickQuestions,
        processed: false,
        professor_name: profName,
        institution: institution,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      paperId: paper.id,
      chatLink: `/chat?id=${paper.id}`,
      message: 'Paper uploaded! Processing in background.',
    });

    const edgeUrl = `${process.env.SUPABASE_URL}/functions/v1/process-chunks`;
    fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        paperId: paper.id,
        text: fullText,
      }),
    }).catch(console.error);

    const summaryUrl = `${process.env.SUPABASE_URL}/functions/v1/generate-summary`;
    fetch(summaryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        paperId: paper.id,
        text: fullText,
        title: paper.title,
      }),
    }).catch(console.error);

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
}
