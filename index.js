import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";
import "dotenv/config";

const app = express();

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db(process.env.DB_NAME);
const booksCollection = db.collection("books");

app.post("/add-book", async (req, res) => {
  const book = req.body;
  try {
    const result = await booksCollection.insertOne(book);
    res.status(201).json({ message: "Book added successfully", bookId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add book" });
  }
})

app.get("/books", async (req, res) => {
  try {
    const books = await booksCollection.find().toArray();
    res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch books" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server is running at ${process.env.PORT}`);
});
