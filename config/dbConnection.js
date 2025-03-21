import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
var mongoURI =
  "mongodb+srv://bhilaresai64:85dSIiDleQnl8d8Y@cluster1.demrb.mongodb.net/?retryWrites=true&w=majority&appName=Cluster1";

const connectDB = async () => {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB Connected Successfully!");
  } catch (error) {
    console.error("MongoDB Connection Failed!", error);
    process.exit(1);
  }
};

export default connectDB;
