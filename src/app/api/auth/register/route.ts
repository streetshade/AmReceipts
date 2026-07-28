import { z } from "zod";
import { registerUser, setSessionCookie } from "@/lib/auth";
import { handler, json, error } from "@/lib/api";

const Body = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const POST = handler(async (req: Request) => {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid input", 422);
  const { email, name, password } = parsed.data;
  try {
    const user = await registerUser(email.toLowerCase(), name, password);
    setSessionCookie(user.id);
    return json({ id: user.id, email: user.email, name: user.name }, 201);
  } catch (e) {
    return error(e instanceof Error ? e.message : "Registration failed", 409);
  }
});
