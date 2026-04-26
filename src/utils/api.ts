export interface ApiErrorDetails {
  error: string;
  code?: string;
  status?: number;
  requestId?: string;
  retryAfter?: string | null;
  details?: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  retryAfter?: string | null;
  details?: string;

  constructor(message: string, options: {
    status: number;
    code?: string;
    requestId?: string;
    retryAfter?: string | null;
    details?: string;
  }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
  }
}

const buildFallbackMessage = (status: number, retryAfter: string | null, requestId: string | null) => {
  if (status === 429) {
    const waitText = retryAfter ? ` 请稍后再试（约 ${retryAfter} 秒）。` : ' 请稍后再试。';
    const reqText = requestId ? ` 请求 ID: ${requestId}` : '';
    return `请求过于频繁。${waitText}${reqText}`.trim();
  }

  return `请求失败 (${status})${requestId ? `，请求 ID: ${requestId}` : ''}`;
};

export async function parseApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id');
  const retryAfter = response.headers.get('retry-after');

  try {
    const data = (await response.json()) as Partial<ApiErrorDetails>;
    const message = data.error || buildFallbackMessage(response.status, retryAfter, requestId);
    return new ApiError(message, {
      status: response.status,
      code: data.code,
      requestId: data.requestId || requestId || undefined,
      retryAfter,
      details: data.details,
    });
  } catch {
    return new ApiError(buildFallbackMessage(response.status, retryAfter, requestId), {
      status: response.status,
      requestId: requestId || undefined,
      retryAfter,
    });
  }
}

export async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await parseApiError(response);
  }
  return response;
}
