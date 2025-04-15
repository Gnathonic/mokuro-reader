import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { TokenResponse, AuthError } from '$lib/types/auth';

// Environment variables for Google OAuth
const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.VITE_GDRIVE_CLIENT_SECRET;
const REDIRECT_URI = import.meta.env.VITE_GDRIVE_REDIRECT_URI || '';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  
  if (error) {
    // Redirect to cloud page with error
    return redirect(302, `/cloud?error=${encodeURIComponent(error)}`);
  }
  
  if (!code) {
    // Redirect to cloud page with error
    return redirect(302, '/cloud?error=No_authorization_code_received');
  }
  
  if (!CLIENT_SECRET) {
    // Redirect to cloud page with error
    return redirect(302, '/cloud?error=Server_not_configured_for_OAuth');
  }

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenResponse.json() as TokenResponse;
    
    if (tokenData.error) {
      console.error('Error exchanging code for tokens:', tokenData);
      return redirect(302, `/cloud?error=${encodeURIComponent(tokenData.error_description || 'Failed to exchange code')}`);
    }

    // Store refresh token in a secure HTTP-only cookie
    if (tokenData.refresh_token) {
      cookies.set('gdrive_refresh_token', tokenData.refresh_token, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24 * 30 * 6, // 6 months
        sameSite: 'lax'
      });
    }

    // Redirect to cloud page with access token in URL fragment
    // This allows the client-side code to retrieve it without exposing it in server logs
    return redirect(302, `/cloud#access_token=${tokenData.access_token}&expires_in=${tokenData.expires_in}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    return redirect(302, '/cloud?error=Internal_server_error');
  }
};