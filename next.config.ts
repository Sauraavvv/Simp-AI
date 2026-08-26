import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server rejects cross-origin requests for its own JS chunks/HMR by
  // default in Next 16 -- opening the app at 127.0.0.1 instead of localhost
  // silently breaks every client component (dropdowns, voice, profile menu)
  // because none of their code ever loads.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
