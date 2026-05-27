import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Must match vercel.json `outputDirectory` (legacy project setting was `dist`, not `.next`).
  distDir: "dist",
  outputFileTracingRoot: path.join(__dirname),
  transpilePackages: ["@arkiv-network/sdk"],
  serverExternalPackages: ["better-sqlite3"],
  webpack: (config, { isServer }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };

    config.module.rules.push({
      test: /\.sql$/,
      type: "asset/source",
    });
    config.module.rules.push({
      test: /\.html$/,
      type: "asset/source",
    });

    if (isServer) {
      config.externals = [...(config.externals ?? []), "bun:sqlite", "better-sqlite3"];
    }

    return config;
  },
};

export default nextConfig;
