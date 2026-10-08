import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second Next process (the Playwright server) use its own build
  // output. Next locks a dist directory to one dev server, and sharing one
  // means a test run wipes the cache out from under `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // App Service runs `node server.js` from a self-contained folder holding
  // only the files the server actually imports — a deploy of tens of
  // megabytes rather than all of node_modules. `.github/workflows/deploy.yml`
  // copies in `public/` and `.next/static`, which standalone leaves out.
  output: "standalone",

  // Every route in TimeHero is per-user: each one reads the session cookie and
  // renders that employee's own data. Nothing is prerenderable, so Cache
  // Components would only mean adding `instant = false` to every page. Revisit
  // if genuinely static pages (a help section, say) ever appear.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
