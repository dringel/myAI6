import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com", // default image host (Cloudinary); add your own host here
      },
    ],
  },
};

export default nextConfig;
