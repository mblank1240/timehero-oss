import type { NextConfig } from "next";

/**
 * Sent with every response.
 *
 * The Content-Security-Policy restricts only what cannot break the app: no
 * framing (clickjacking), no `<base>` rewriting, no plugins. It sets no
 * `script-src` or `style-src` — Next's inline bootstrap scripts need a
 * per-request nonce for that, which in turn forces every page dynamic.
 *
 * It also sets no `form-action`. Signing in posts a form to a server action
 * that redirects to Microsoft or Google; before hydration that is a real form
 * submission, and Chrome applies `form-action` to where it redirects, so
 * `form-action 'self'` would block signing in.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Browsers ignore it over plain http, so it is safe to send in development.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

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

  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
