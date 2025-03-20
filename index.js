import express from "express";
import connectDB from "./config/dbConnection.js";
import router from "./router/routeAnalysis.js";
const app = express();
app.use(express.json());

app.use("/api/safety", router);
const PORT = process.env.PORT || 4000;

await connectDB();

app.listen(PORT, () => {
  console.log("addres is : http://localhost:4000/api/safety/analyze-routes");
  console.log(`Server running on port ${PORT}`);
});
