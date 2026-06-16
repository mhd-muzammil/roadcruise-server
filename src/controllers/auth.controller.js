import { readDb, writeDb } from "../utils/db.js";

export const login = (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const db = readDb();
  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  // Success payload without password
  const { password: _, ...userPayload } = user;
  res.json(userPayload);
};

export const register = (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required" });
  }

  const db = readDb();
  const exists = db.users.some(u => u.email.toLowerCase() === email.toLowerCase().trim());
  if (exists) {
    return res.status(409).json({ error: "User with this email already exists" });
  }

  const newUser = {
    name,
    email: email.toLowerCase().trim(),
    phone: phone || "+91 99999 99999",
    password,
    role: "customer" // Registered via signup are always customers
  };

  db.users.push(newUser);
  writeDb(db);

  const { password: _, ...userPayload } = newUser;
  res.status(211).json(userPayload);
};
