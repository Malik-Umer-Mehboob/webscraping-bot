import { NextResponse } from 'next/server';
import dbConnect from '@/utils/db';
import User from '@/models/User';
import { z } from 'zod';

// Enhanced validation schema
const loginSchema = z.object({
  email: z.string()
    .email('Invalid email address')
    .min(1, 'Email is required')
    .max(255, 'Email is too long'),
  password: z.string()
    .min(1, 'Password is required')
    .max(100, 'Password is too long')
});

// Rate limiting setup
const loginAttempts = new Map();
const MAX_ATTEMPTS = 10;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes

export async function POST(request: Request) {
  await dbConnect();

  try {
    const body = await request.json();
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    const now = Date.now();

    // Check for rate limiting
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= MAX_ATTEMPTS && now - attempts.lastAttempt < LOCKOUT_TIME) {
      return NextResponse.json(
        { message: 'Too many login attempts. Please try again later.' }, 
        { status: 429 }
      );
    }

    // Validate input
    const { email, password } = loginSchema.parse(body);

    // Find user with password field included
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      // Increment failed attempts
      loginAttempts.set(ip, { 
        count: attempts.count + 1, 
        lastAttempt: now 
      });
      
      return NextResponse.json(
        { message: 'Invalid credentials' }, 
        { status: 401 }
      );
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return NextResponse.json(
        { message: 'Account temporarily locked. Please try again later.' }, 
        { status: 423 }
      );
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      // Increment failed attempts
      user.failedLoginAttempts += 1;
      
      // Lock account after too many failed attempts
      if (user.failedLoginAttempts >= MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_TIME);
        await user.save();
        
        return NextResponse.json(
          { message: 'Account locked due to too many failed attempts. Please try again later.' }, 
          { status: 423 }
        );
      }
      
      await user.save();
      
      // Update rate limiting
      loginAttempts.set(ip, { 
        count: attempts.count + 1, 
        lastAttempt: now 
      });
      
      return NextResponse.json(
        { message: 'Invalid credentials' }, 
        { status: 401 }
      );
    }

    // Reset failed attempts on successful login
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLogin = new Date();
    await user.save();

    // Return user data (excluding sensitive information)
    const userData = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      name: user.name,
    };

    return NextResponse.json(
      { 
        message: 'Login successful', 
        user: userData,
      }, 
      { status: 200 }
    );

  } catch (error: any) {
    console.error('Login error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { 
          message: 'Validation Error', 
          errors: error.errors.map(e => ({
            field: e.path[0],
            message: e.message
          }))
        }, 
        { status: 400 }
      );
    }

    return NextResponse.json(
      { message: 'Internal server error' }, 
      { status: 500 }
    );
  }
}

// Clean up old rate limiting entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now - attempt.lastAttempt > LOCKOUT_TIME * 2) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000); // Run every hour