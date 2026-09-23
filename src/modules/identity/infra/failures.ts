import { failure, type Failure } from '../../../shared/errors/index.js';

/** Another operation changed the record after this operation read it. */
export const staleWrite = (): Failure =>
  failure('conflict', 'record was changed by a concurrent operation', {
    type: 'identity.stale_write',
  });

export const emailTaken = (): Failure =>
  failure('conflict', 'email is already registered', {
    type: 'identity.email_taken',
  });

export const alreadyExists = (): Failure =>
  failure('conflict', 'identity already exists', {
    type: 'identity.already_exists',
  });

export const challengeExists = (): Failure =>
  failure('conflict', 'verification challenge already exists', {
    type: 'identity.challenge_already_exists',
  });

export const sessionExists = (): Failure =>
  failure('conflict', 'session already exists', {
    type: 'identity.session_already_exists',
  });
