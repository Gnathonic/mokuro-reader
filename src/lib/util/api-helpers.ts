/**
 * Error types for Google Drive API calls
 */
export enum DriveErrorType {
  AUTH_ERROR = 'auth_error',
  RATE_LIMIT = 'rate_limit',
  CONNECTION_ERROR = 'connection_error',
  OTHER_ERROR = 'other_error'
}

/**
 * Options for the fetchWithRetry function
 */
export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffFactor?: number;
  retryStatusCodes?: number[];
  retryNetworkErrors?: boolean;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffFactor: 2,
  retryStatusCodes: [408, 429, 500, 502, 503, 504],
  retryNetworkErrors: true
};

/**
 * Determines the type of error from a fetch response or error object
 * @param response The fetch response or error
 * @returns The type of error
 */
export function determineErrorType(response: Response | Error): DriveErrorType {
  // Network errors (offline, connection refused, etc.)
  if (response instanceof Error) {
    const errorMessage = response.message.toLowerCase();
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('offline') ||
      errorMessage.includes('internet')
    ) {
      return DriveErrorType.CONNECTION_ERROR;
    }
    return DriveErrorType.OTHER_ERROR;
  }

  // HTTP status code based errors
  if (response.status === 401 || response.status === 403) {
    return DriveErrorType.AUTH_ERROR;
  }

  if (response.status === 429) {
    return DriveErrorType.RATE_LIMIT;
  }

  if (response.status >= 500 && response.status < 600) {
    return DriveErrorType.CONNECTION_ERROR;
  }

  return DriveErrorType.OTHER_ERROR;
}

/**
 * Performs a fetch request with retry logic for different error types
 * @param url The URL to fetch
 * @param options The fetch options
 * @param retryOptions Options for retry behavior
 * @returns A promise that resolves to the fetch response
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  let retries = 0;
  let backoffMs = opts.initialBackoffMs!;

  while (true) {
    try {
      const response = await fetch(url, options);

      // If the response is ok or we've reached max retries, return it
      if (response.ok || retries >= opts.maxRetries!) {
        return response;
      }

      // Determine if we should retry based on status code
      const shouldRetry = opts.retryStatusCodes!.includes(response.status);
      if (!shouldRetry) {
        return response;
      }

      // For rate limiting, try to get retry-after header
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          // retry-after can be a number of seconds or a date
          const retryAfterMs = isNaN(Number(retryAfter))
            ? new Date(retryAfter).getTime() - Date.now()
            : Number(retryAfter) * 1000;

          backoffMs = Math.max(backoffMs, retryAfterMs);
        }
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      // Increase backoff for next retry
      backoffMs = Math.min(backoffMs * opts.backoffFactor!, opts.maxBackoffMs!);
      retries++;

    } catch (error) {
      // Network errors
      if (!opts.retryNetworkErrors || retries >= opts.maxRetries!) {
        throw error;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      // Increase backoff for next retry
      backoffMs = Math.min(backoffMs * opts.backoffFactor!, opts.maxBackoffMs!);
      retries++;
    }
  }
}

/**
 * Performs a Google Drive API request with proper error handling and retry logic
 * @param url The API URL
 * @param options The fetch options
 * @param retryOptions Options for retry behavior
 * @returns A promise that resolves to the parsed JSON response
 * @throws An error with the appropriate error type
 */
export async function driveApiRequest<T = any>(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<T> {
  try {
    const response = await fetchWithRetry(url, options, retryOptions);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error: any = new Error(errorData.error?.message || `HTTP error ${response.status}`);
      error.status = response.status;
      error.errorType = determineErrorType(response);
      error.response = response;
      throw error;
    }

    // For empty responses (like DELETE)
    if (response.status === 204) {
      return {} as T;
    }

    return await response.json();
  } catch (error: any) {
    // If it's already been processed, rethrow
    if (error.errorType) {
      throw error;
    }

    // Process network errors
    error.errorType = determineErrorType(error);
    throw error;
  }
}