/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // npm run dev opened from another device on the same Wi-Fi (http://192.168.1.20:3000, say):
  // let it reach the dev server's own connection too. Only used by next dev.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local']
};
export default nextConfig;
