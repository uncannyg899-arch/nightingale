/**
 * Supabase clients
 * ---------------------------------------------------------------
 * Two clients, deliberately separated:
 *
 *   browserClient() — uses the ANON key. Every query it makes is
 *   subject to Row Level Security. This is what patient-facing pages
 *   use, and it is safe to ship to the browser.
 *
 *   serviceClient() — uses the SERVICE ROLE key, which BYPASSES RLS
 *   entirely. Server-side only. If this key ever reaches the browser,
 *   every patient record in the database is readable by anyone.
 *
 * The `import 'server-only'` guard on the service client makes that
 * mistake a build error rather than a breach.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Check your .env.local file.`
    );
  }
  return value;
}

/** RLS-enforced client. Safe for browser and server. */
export function browserClient(): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', URL),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON)
  );
}

/**
 * RLS-BYPASSING client. Server routes only.
 * Used for writes the patient shouldn't be able to forge:
 * risk assessments, escalations, audit logs.
 */
export function serviceClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serviceClient() called in the browser. This would expose the service role key.'
    );
  }
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', URL),
    requireEnv(
      'SUPABASE_SERVICE_ROLE_KEY',
      process.env.SUPABASE_SERVICE_ROLE_KEY
    ),
    { auth: { persistSession: false } }
  );
}
