import mongoose, { Schema } from "mongoose";

const userScheme = new Schema({
  name: { type: String, required: true, trim: true },

  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
  },

  password: { type: String, required: true },
  token: { type: String },
});

const User = mongoose.model("User", userScheme);

export { User };