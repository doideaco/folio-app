export class AppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = "error") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const unauthorized = (m = "unauthorized") => new AppError(401, m, "unauthorized");
export const forbidden = (m = "forbidden") => new AppError(403, m, "forbidden");
export const notFound = (m = "not found") => new AppError(404, m, "not_found");
export const conflict = (m: string) => new AppError(409, m, "conflict");
export const badRequest = (m: string) => new AppError(422, m, "bad_request");
