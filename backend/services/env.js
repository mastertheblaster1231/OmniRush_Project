/**
 * Load backend configuration before any service-level constants are evaluated.
 *
 * Services import this module as a dependency, so dotenv runs during ESM
 * module evaluation rather than later in server.js after those services have
 * already captured process.env.
 */
import dotenv from 'dotenv';

dotenv.config();

export default process.env;
