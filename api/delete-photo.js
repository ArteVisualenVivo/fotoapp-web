import crypto from 'node:crypto';

/* global process */

function parseBearerToken(headerValue) {
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    return null;
  }

  return headerValue.slice('Bearer '.length).trim();
}

function buildCloudinarySignature(publicId, timestamp, apiSecret) {
  const toSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  return crypto.createHash('sha1').update(toSign).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const requestBody =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});

    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: 'Missing authorization token.' });
    }

    const publicId = requestBody.publicId;
    if (!publicId) {
      return res.status(400).json({ error: 'Missing Cloudinary publicId.' });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(500).json({ error: 'Cloudinary environment variables are missing.' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildCloudinarySignature(publicId, timestamp, apiSecret);

    const body = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      api_key: apiKey,
      signature,
    });

    const cloudinaryResponse = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    );

    const result = await cloudinaryResponse.json();
    if (!cloudinaryResponse.ok || (result.result !== 'ok' && result.result !== 'not found')) {
      return res.status(500).json({ error: result.error?.message || 'Cloudinary delete failed.' });
    }

    return res.status(200).json({ ok: true, result: result.result });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected error.' });
  }
}
