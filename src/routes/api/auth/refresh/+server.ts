import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { TokenResponse, RefreshTokenRequest, AuthError } from '$lib/types/auth';

// Environment variables for Google OAuth
const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
const CLIENT_SECRET = import.meta.env.VITE_GDRIVE_CLIENT_SECRET;
const REDIRECT_URI = import.meta.env.VITE_GDRIVE_REDIRECT_URI || '';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { refresh_token } = await request.json() as RefreshTokenRequest;
    
    if (!refresh_token) {
      return json({ error: 'Refresh token is required' } as AuthError, { status: 400 });
    }
    
    if (!CLIENT_SECRET) {
      return json({ error: 'Server is not configured for token refresh' } as AuthError, { status: 500 });
    }

    // Exchange refresh token for a new access token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refresh_token,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await tokenResponse.json() as TokenResponse;
    
    if (tokenData.error) {
      console.error('Error refreshing token:', tokenData);
      return json({ 
        error: tokenData.error, 
        error_description: tokenData.error_description || 'Failed to refresh token' 
      } as AuthError, { status: 401 });
    }

    // Return the new access token and expiration time
    return json({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in
    } as TokenResponse);
  } catch (error) {
    console.error('Token refresh error:', error);
    return json({ error: 'Internal server error' } as AuthError, { status: 500 });
  }
};