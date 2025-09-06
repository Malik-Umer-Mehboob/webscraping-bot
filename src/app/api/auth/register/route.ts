import { NextResponse } from 'next/server';
import dbConnect from '@/utils/db';
import User from '@/models/User';
import { z } from 'zod';

// Enhanced validation schema
const registerSchema = z.object({
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  email: z.string()
    .email('Invalid email address')
    .min(1, 'Email is required')
    .max(255, 'Email is too long'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password is too long'),
  name: z.string()
    .max(50, 'Name is too long')
    .optional()
    .or(z.literal('')),
  agreeToTerms: z.boolean()
    .refine(val => val === true, 'You must agree to the terms and conditions')
});

// Password complexity validation function
function validatePasswordComplexity(password: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

export async function POST(request: Request) {

  await dbConnect();

  try {
    const body = await request.json();
    const { username, email, password, name, agreeToTerms } = registerSchema.parse(body);

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] 
    });
    
    if (existingUser) {
      if (existingUser.email === email.toLowerCase()) {
        return NextResponse.json({ 
          message: 'User with this email already exists',
          field: 'email'
        }, { status: 409 });
      } else {
        return NextResponse.json({ 
          message: 'Username is already taken',
          field: 'username'
        }, { status: 409 });
      }
    }

    // Validate password complexity
    const passwordValidation = validatePasswordComplexity(password);
    if (!passwordValidation.isValid) {
      return NextResponse.json({ 
        message: 'Password does not meet complexity requirements',
        errors: passwordValidation.errors,
        field: 'password'
      }, { status: 400 });
    }

    // Create new user

    
    const newUser = new User({ 
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: password,
      name: name?.trim() || '',
      emailVerified: false
    });

    await newUser.save();

    // Remove password from response
    const userResponse = {
  id: newUser._id,
  username: newUser.username,
  email: newUser.email,
  name: newUser.name,
  createdAt: newUser.createdAt
};

return NextResponse.json({ 
  message: 'User registered successfully',
  user: userResponse
}, { status: 201 });

} catch (error: unknown) {
  console.error('Registration error:', error);

  if (error instanceof z.ZodError) {
    const fieldErrors = error.issues.map(err => ({
      field: err.path[0],
      message: err.message
    }));

    return NextResponse.json({ 
      message: 'Validation Error', 
      errors: fieldErrors 
    }, { status: 400 });
  }

  // Handle duplicate key errors from MongoDB
if (typeof error === "object" && error !== null && "code" in error) {
  const errObj = error as { code?: number; keyValue?: Record<string, number> };

  if (errObj.code === 11000 && errObj.keyValue) {
    const field = Object.keys(errObj.keyValue)[0];
    return NextResponse.json(
      {
        message: `User with this ${field} already exists`,
        field,
      },
      { status: 409 }
    );
  }
}

return NextResponse.json(
  {
    message: "Internal server error",
    error:
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.message
        : undefined,
  },
  { status: 500 }
);
}}

// Optional: Add GET method to check username/email availability
export async function GET(request: Request) {
  await dbConnect();

  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const username = searchParams.get('username');

    if (!email && !username) {
      return NextResponse.json({ 
        message: 'Email or username parameter is required' 
      }, { status: 400 });
    }

    // ✅ Fix query type
    const query: Record<string, string> = {};
    if (email) query.email = email.toLowerCase();
    if (username) query.username = username.toLowerCase();

    const existingUser = await User.findOne(query);

    return NextResponse.json({ 
      available: !existingUser,
      exists: !!existingUser,
      field: email ? 'email' : 'username'
    }, { status: 200 });

  } catch (error) {
    console.error('Availability check error:', error);
    return NextResponse.json({ 
      message: 'Internal server error' 
    }, { status: 500 });
  }}