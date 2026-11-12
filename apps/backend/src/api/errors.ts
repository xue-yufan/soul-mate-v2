export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireFeature(
  enabled: boolean,
  message: string,
): void {
  if (!enabled) throw new HttpError(503, message);
}

export function queryInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `参数必须是 ${min}..${max} 的整数`);
  }
  return number;
}

export function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
