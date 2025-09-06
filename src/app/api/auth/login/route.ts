import { NextResponse } from 'next/server';
import dbConnect from '@/utils/db';
import User from '@/models/User';
import { z, ZodError } from 'zod';

// ----------------------
// Zod validation schema
// ----------------------
const loginSchema = z.object({
  email: z.string()
    .email('Invalid email address')
    .min(1, 'Email is required')
    .max(255, 'Email is too long'),
  password: z.string()
    .min(1, 'Password is required')
    .max(100, 'Password is too long')
});

// ----------------------
// Rate limiting setup
// ----------------------
interface LoginAttempt {
  count: number;
  lastAttempt: number;
}
const loginAttempts = new Map<string, LoginAttempt>();
const MAX_ATTEMPTS = 10;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes

// ----------------------
// POST handler
// ----------------------
export async function POST(request: Request) {
  await dbConnect();

  try {
    const body: unknown = await request.json();
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();

    // ----------------------
    // Rate limiting check
    // ----------------------
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= MAX_ATTEMPTS && now - attempts.lastAttempt < LOCKOUT_TIME) {
      return NextResponse.json(
        { message: 'Too many login attempts. Please try again later.' },
        { status: 429 }
      );
    }

    // ----------------------
    // Input validation
    // ----------------------
   let email: string;
let password: string;

try {
  const parsed = loginSchema.parse(body);
  email = parsed.email;
  password = parsed.password;
} catch (err) {
  if (err instanceof ZodError) {
    return NextResponse.json({
      message: 'Validation Error',
      errors: err.issues.map(e => ({
        field: e.path[0],
        message: e.message
      }))
    }, { status: 400 });
  }
  throw err; // Unexpected error
}

    // ----------------------
    // Find user
    // ----------------------
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      loginAttempts.set(ip, {
        count: attempts.count + 1,
        lastAttempt: now
      });

      return NextResponse.json({ message: 'Invalid credentials' }, { status: 401 });
    }

    // ----------------------
    // Account lock check
    // ----------------------
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return NextResponse.json(
        { message: 'Account temporarily locked. Please try again later.' },
        { status: 423 }
      );
    }

    // ----------------------
    // Password verification
    // ----------------------
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      user.failedLoginAttempts += 1;

      if (user.failedLoginAttempts >= MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_TIME);
        await user.save();

        return NextResponse.json(
          { message: 'Account locked due to too many failed attempts. Please try again later.' },
          { status: 423 }
        );
      }

      await user.save();

      loginAttempts.set(ip, {
        count: attempts.count + 1,
        lastAttempt: now
      });

      return NextResponse.json({ message: 'Invalid credentials' }, { status: 401 });
    }

    // ----------------------
    // Successful login
    // ----------------------
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLogin = new Date();
    await user.save();

    const userData = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      name: user.name
    };

    return NextResponse.json({ message: 'Login successful', user: userData }, { status: 200 });

  } catch (error: unknown) {
    console.error('Login error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}

// ----------------------
// Clean up rate limiting map periodically
// ----------------------
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now - attempt.lastAttempt > LOCKOUT_TIME * 2) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000); // Run every hour
