export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(entity: string, detail: string) {
    super(`${entity} conflict: ${detail}`);
    this.name = "ConflictError";
  }
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}
