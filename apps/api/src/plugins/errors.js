/**
 * Request identity and error handling.
 *
 * Every response carries a request id, and that id appears in the logs, in the audit
 * records and in error responses. When somebody reports "it failed at 14:32", the id is
 * what turns that into a single log line.
 *
 * Error responses never contain a stack trace or an internal message: application
 * errors carry a message written for a user, and anything else becomes a generic 500
 * with the correlation id.
 */
import fp from 'fastify-plugin';
import { createLogger, serializeError } from '@frm/logging';
import { isAppError, newRequestId, toAppError } from '@frm/shared';

const log = createLogger('api.error');

async function errorPlugin(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    request.requestId =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : newRequestId();
    reply.header('x-request-id', request.requestId);
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.' },
      requestId: request.requestId,
    });
  });

  fastify.setErrorHandler((error, request, reply) => {
    // Fastify's own validation and rate-limit errors carry a statusCode.
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again.' },
        requestId: request.requestId,
      });
    }

    if (isAppError(error)) {
      const level = error.httpStatus >= 500 ? 'error' : 'warn';
      log[level](
        {
          requestId: request.requestId,
          method: request.method,
          url: request.url,
          code: error.code,
          err: serializeError(error),
        },
        'request failed',
      );
      return reply
        .status(error.httpStatus)
        .send({ ...error.toPublicJSON(), requestId: request.requestId });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'The request body or query is invalid.' },
        requestId: request.requestId,
      });
    }

    const wrapped = toAppError(error);
    log.error(
      {
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        err: serializeError(error),
      },
      'unhandled request error',
    );

    return reply.status(wrapped.httpStatus >= 400 ? wrapped.httpStatus : 500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong. Quote the request id when reporting this.',
      },
      requestId: request.requestId,
    });
  });
}

export default fp(errorPlugin, { name: 'frm-errors' });
