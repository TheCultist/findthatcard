import path from "path";

function isServerlessEnvironment(): boolean {
  return Boolean(
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL ||
      process.env.NETLIFY ||
      process.env.FLY_APP_NAME
  );
}

export function getCacheDir(): string {
  const configured = process.env.CACHE_DIR?.trim();
  if (configured) {
    return configured;
  }
  if (isServerlessEnvironment()) {
    return "/tmp";
  }
  return path.join(process.cwd(), "data");
}
