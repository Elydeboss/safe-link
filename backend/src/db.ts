import mongoose from 'mongoose';
import { config } from './config';

export async function connectDb(): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  return mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
}
