/**
 * Browser auth client
 * ---------------------------------------------------------------
 * Uses the ANON key only, so every query it makes is subject to row
 * level security. This file is safe to ship to the browser; the
 * service-role client in lib/supabase.ts is not, and throws if it is
 * ever constructed here.
 *
 * Magic link rather than password: nothing to store, forget, or
 * reuse. In a health context that is one fewer credential that can
 * leak.
 */

'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function authClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    throw new Error(
      'Supabase environment variables are missing. Check .env.local.'
    );
  }

  client = createClient(url, anon);
  return client;
}

/**
 * Send a magic link. The session id rides along in the redirect so
 * that when the person returns, we know which guest conversation to
 * attach them to.
 */
export async function sendMagicLink(
  email: string,
  sessionId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const redirectTo = `${window.location.origin}/?session=${sessionId}`;
    const { error } = await authClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function currentUser() {
  const { data } = await authClient().auth.getUser();
  return data.user ?? null;
}

export async function signOut(): Promise<void> {
  await authClient().auth.signOut();
}
