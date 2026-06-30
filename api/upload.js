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

  try {
    // --- 1. Auth Check ---
    const auth = req.headers.authorization;
    const token = auth?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization token' });
    }

    const { data: prof, error: profError } = await supabase
      .from('professors')
      .select('id')
      .eq('id', token)
      .single();

    if (profError || !prof) {
      return res.status(401).json({ error: 'Invalid Professor ID. Please log out and log in again.' });
    }

    // --- 2. Parse Form (File + Fields) ---
    const form = formidable({ 
      maxFileSize: 10 * 1024 * 1024, // 10MB
      keepExtensions: true 
    });
    
    const [fields, files] = await form.parse(req);

    const file = files.pdf?.[0];
    if (!file) {
      return res.status(400).json({ error: 'No PDF file found in the request.' });
    }

    const title = fields.title?.[0] || 'Untitled';
    const description = fields.description?.[0] || '';
    const enableContext = fields.enableContext?.[0] === 'true';
    const quickQuestions = JSON.parse(fields.quickQuestions?.[0] || '[]');
    const profName = fields.profName?.[0] || '';
    const institution = fields.institution?.[0] || '';

    // --- 3. Read and Parse PDF ---
    let fullText = '';
    try {
      const buffer = fs.readFileSync(file.filepath);
      const pdfData = await pdfParse(buffer);
      fullText = pdfData.text;
      
      if (!fullText || fullText.trim().length === 0) {
        return res.status(400).json({ error: 'The PDF appears to be empty or contains only images/scanned content. Please use a text-based PDF.' });
      }
    } catch (pdfError) {
      // This is the most common failure point. Send the exact error.
      return res.status(500).json({ 
        error: 'PDF Parsing Failed', 
        detail: pdfError.message,
        stack: pdfError.stack 
      });
    }

    // --- 4. Insert into Supabase ---
    let paper;
    try {
      const { data, error } = await supabase
        .from('papers')
        .insert({
          professor_id: token,
          title,
          filename: file.originalFilename || 'unknown.pdf',
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
      paper = data;
    } catch (dbError) {
      return res.status(500).json({ 
        error: 'Database Insert Failed', 
        detail: dbError.message 
      });
    }

    // --- 5. Respond Successfully ---
    res.status(200).json({
      success: true,
      paperId: paper.id,
      chatLink: `/chat?id=${paper.id}`,
      message: 'Paper uploaded! Processing in background.',
    });

    // --- 6. Fire-and-Forget Edge Functions (Background) ---
    try {
      const edgeUrl = `${process.env.SUPABASE_URL}/functions/v1/process-chunks`;
      await fetch(edgeUrl, {
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
      await fetch(summaryUrl, {
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
    } catch (bgError) {
      console.error('Background processing error:', bgError);
      // Don't fail the upload if background tasks fail
    }

  } catch (err) {
    // --- Catch-all for any other unexpected errors ---
    console.error('Upload Error:', err);
    res.status(500).json({ 
      error: 'Upload failed', 
      detail: err.message,
      stack: err.stack 
    });
  }
}
