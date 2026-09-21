/**
 * Wall timestamps and monotonic elapsed readings with explicit test control.
 *
 * A wall correction changes only the wall reading. An advance moves wall and
 * elapsed time together. Dates are copied at both boundaries, and elapsed
 * readings are bigint nanoseconds from one instance's private origin.
 */
export {
  FakeClock,
  SystemClock,
  type Clock,
  type MonotonicClock,
  type WallClock,
} from './clock.js';
