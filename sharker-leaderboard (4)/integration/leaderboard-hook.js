// leaderboard-hook.js
// Call registerLaunch(...) from your platform-creation success handler on
// sharker.com/partners. It pushes the launch to the live leaderboard and saves
// it to the Supabase `launches` table.
//
// Requires (server-side env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   -> your Supabase project
//   LEADERBOARD_URL                           -> e.g. https://board.sharker.com
//   LEADERBOARD_LAUNCH_KEY                    -> matches LAUNCH_KEY on the board (optional)
//
// Run this on the SERVER (Next.js route handler / API route), never the browser —
// the service role key must stay secret.

import { createClient } from "@supabase/supabase-js";

let _supabase;
function getSupabase() {
  // If you already have a shared Supabase client, return that instead.
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

const LAUNCH_KEY = () => process.env.LEADERBOARD_LAUNCH_KEY;
const LEADERBOARD_URL = () => process.env.LEADERBOARD_URL;

/**
 * Register a successful platform creation.
 * @param {Object} launch
 * @param {string}  launch.platformName  (required)
 * @param {string} [launch.ownerName]
 * @param {string} [launch.country]
 * @param {string} [launch.email]
 * @param {string} [launch.wallet]
 * @param {string} [launch.platformUrl]
 * @param {string} [launch.launchTime]   ISO string; defaults to now
 */
export async function registerLaunch(launch) {
  console.log("Platform created successfully");

  const payload = {
    platformName: launch.platformName,
    ownerName:    launch.ownerName ?? null,
    country:      launch.country ?? null,
    email:        launch.email ?? null,
    wallet:       launch.wallet ?? null,
    platformUrl:  launch.platformUrl ?? null,
    launchTime:   launch.launchTime ?? new Date().toISOString(),
  };

  // 1) push to the live leaderboard so it appears instantly on the board
  try {
    console.log("Sending launch to leaderboard");
    const res = await fetch(`${LEADERBOARD_URL()}/api/launch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LAUNCH_KEY() ? { "x-launch-key": LAUNCH_KEY() } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`.trim());
    }
    console.log("Launch saved to leaderboard");
  } catch (error) {
    console.error("Leaderboard API error", error);
  }

  // 2) persist to the Supabase launches table
  try {
    const { data, error } = await getSupabase()
      .from("launches")
      .insert({
        platform_name: payload.platformName,
        owner_name:    payload.ownerName,
        country:       payload.country,
        email:         payload.email,
        wallet:        payload.wallet,
        platform_url:  payload.platformUrl,
        launch_time:   payload.launchTime,
        status:        "Entered",
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Supabase insert error", error);
    return null;
  }
}
