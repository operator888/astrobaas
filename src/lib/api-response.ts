// Standardized API Response Utility
// This ensures consistent response formats across all API endpoints

export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  meta?: {
    total?: number;
    page?: number;
    limit?: number | null;
    [key: string]: any;
  };
}

/** Machine-readable codes for the statuses a service layer may hand back. */
const ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
};

export interface ApiErrorResponse {
  success: false;
  error: {
    /** Human-readable English. The fallback for a client that knows no codes. */
    message: string;
    /** HTTP-status class: BAD_REQUEST, NOT_FOUND, … Derived from the status. */
    code?: string;
    /**
     * The SPECIFIC reason, e.g. `checkout.qty_over_limit`.
     *
     * What a storefront translates. `code` says a request was bad; `reason`
     * says why, stably enough to key a message catalogue on.
     */
    reason?: string;
    /** Values for the translated sentence, e.g. `{ max: 3 }`. */
    params?: Record<string, string | number>;
    details?: any;
  };
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

export class ApiResponseBuilder {
  /**
   * Create a successful API response
   */
  static success<T>(data: T, message?: string, meta?: ApiSuccessResponse<T>['meta']): Response {
    const response: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      ...(meta && { meta })
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a successful creation response (201)
   *
   * `meta` is optional and was added late: a 201 could not carry the envelope
   * metadata a 200 could, so POST /api/media/upload had no way to publish the
   * resolved media base that GET /api/media/get publishes. Switching it to
   * success() would have changed the status from 201 to 200, which is a real
   * break for any client that checks it.
   */
  static created<T>(data: T, message?: string, meta?: ApiSuccessResponse<T>['meta']): Response {
    const response: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(message && { message }),
      ...(meta && { meta })
    };

    return new Response(JSON.stringify(response), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a successful deletion response (204 or 200)
   */
  static deleted(message: string = 'Resource deleted successfully'): Response {
    const response: ApiSuccessResponse<null> = {
      success: true,
      data: null,
      message
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a bad request error response (400)
   */
  static badRequest(message: string, details?: any): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code: 'BAD_REQUEST',
        ...(details && { details })
      }
    };

    return new Response(JSON.stringify(response), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Error response carrying a status a service layer already decided.
   *
   * Domain services (commerce, in particular) distinguish "your request is
   * malformed" from "the world changed under you" — 409 when someone else took
   * the last unit, 404 when the row is gone. Flattening those to 400 tells a
   * client not to retry something it *should* retry, so routes that call such a
   * service must forward its status instead of picking one themselves.
   */
  static error(
    status: number,
    message: string,
    details?: any,
    /**
     * A REASON code, distinct from the HTTP-status code above.
     *
     * `code` has always been derived from the status, so every refusal at
     * checkout arrived as `BAD_REQUEST` — true, and useless to a storefront
     * that wants to say "you can order at most 3 of these" in German. `reason`
     * carries the specific one, with the values needed to build the sentence.
     *
     * Additive: `code` keeps its meaning, so no existing client changes.
     */
    reason?: { code?: string; params?: Record<string, string | number> },
  ): Response {
    const code = ERROR_CODES[status] ?? (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code,
        ...(reason?.code && { reason: reason.code }),
        ...(reason?.params && { params: reason.params }),
        ...(details && { details })
      }
    };

    return new Response(JSON.stringify(response), {
      status: status >= 400 && status <= 599 ? status : 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a not found error response (404)
   */
  static notFound(resource: string = 'Resource'): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message: `${resource} not found`,
        code: 'NOT_FOUND'
      }
    };

    return new Response(JSON.stringify(response), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create an internal server error response (500)
   */
  static serverError(message: string = 'Internal server error', details?: any): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code: 'INTERNAL_SERVER_ERROR',
        ...(details && { details })
      }
    };

    return new Response(JSON.stringify(response), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a validation error response (422)
   */
  static validationError(message: string, details?: any): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code: 'VALIDATION_ERROR',
        ...(details && { details })
      }
    };

    return new Response(JSON.stringify(response), {
      status: 422,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create an unauthorized error response (401)
   */
  static unauthorized(message: string = 'Unauthorized'): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code: 'UNAUTHORIZED'
      }
    };

    return new Response(JSON.stringify(response), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Create a forbidden error response (403)
   */
  static forbidden(message: string = 'Forbidden'): Response {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        message,
        code: 'FORBIDDEN'
      }
    };

    return new Response(JSON.stringify(response), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}