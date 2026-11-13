import express from "express";
import { MongoClient, ObjectId } from "mongodb";
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
const borrowsBooksCollection = db.collection("borrows");

app.post("/add-book", async (req, res) => {
  const book = req.body;
  try {
    if (book.totalCopies !== undefined) {
      book.totalCopies = Math.max(0, Number(book.totalCopies) || 0);
    }
    const result = await booksCollection.insertOne(book);
    res.status(201).json({ message: "Book added successfully", bookId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add book" });
  }
})

app.get("/books", async (req, res) => {
  const { limit, sort } = req.query;
  try {
    let cursor = booksCollection.find();

    // Show newest books first when requested using MongoDB sort
    if (sort === "newest" || sort === "desc" || sort === "-1") {
      cursor = cursor.sort({ _id: -1 });
    }

    // Apply limit directly in MongoDB
    if (limit) {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        cursor = cursor.limit(parsedLimit);
      }
    }

    const books = await cursor.toArray();
    res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch books" });
  }
});

// Dedicated New Arrivals / Latest Books API (sort newest first & limit in MongoDB)
app.get("/latest-books", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 6;
    const books = await booksCollection
      .find()
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
    res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch latest books" });
  }
});

app.get("/book/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const book = await booksCollection.findOne({ _id: new ObjectId(id) });
    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }
    res.json(book);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch book" });
  }
});

app.get("/my-books/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const books = await booksCollection
      .find({
        $or: [
          { userEmail: email },
          { "addedBy.email": email },
          { addedBy: email },
        ],
      })
      .toArray();
    res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch my books" });
  }
});

//update my-books book
app.patch("/my-books/:id", async (req, res) => {
  const { id } = req.params;
  const updatedBook = req.body;
  delete updatedBook._id;

  if (updatedBook.totalCopies !== undefined) {
    updatedBook.totalCopies = Math.max(0, Number(updatedBook.totalCopies) || 0);
  }

  try {
    const result = await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedBook }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Book not found" });
    }

    res.json({ message: "Book updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update book" });
  }
});

app.delete("/my-books/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await booksCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Book not found" });
    }

    res.json({ message: "Book deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete book" });
  }
});

//Borrowed Books API - borrow a book and decrease inventory (never negative)
app.post("/my-borrows", async (req, res) => {
  const borrow = req.body;
  try {
    if (!borrow.bookId) {
      return res.status(400).json({ message: "Book ID is required" });
    }

    // 1. Find book to verify inventory
    let book = null;
    try {
      book = await booksCollection.findOne({ _id: new ObjectId(borrow.bookId) });
    } catch {
      return res.status(400).json({ message: "Invalid Book ID format" });
    }

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    // 2. Parse current inventory and ensure it is not 0 or negative
    const currentCopies = Math.max(0, Number(book.totalCopies) || 0);
    if (currentCopies <= 0) {
      return res.status(400).json({ message: "This book is currently out of stock." });
    }

    // 3. Decrement inventory (guaranteed never negative)
    const newCopies = Math.max(0, currentCopies - 1);
    await booksCollection.updateOne(
      { _id: new ObjectId(borrow.bookId) },
      { $set: { totalCopies: newCopies } }
    );

    // 4. Save borrow record
    const result = await borrowsBooksCollection.insertOne(borrow);
    res.status(201).json({
      message: "Borrow record added successfully",
      borrowId: result.insertedId,
      remainingCopies: newCopies,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add borrow record" });
  }
});

//get the borrows of the logged in user
app.get("/my-borrows/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const borrows = await borrowsBooksCollection.find({ userEmail: email }).toArray();
    res.json(borrows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch borrow records" });
  }
});

//delete borrowed book / return a book and increase inventory (never negative)
app.delete("/my-borrows/:id", async (req, res) => {
  const { id } = req.params;

  try {
    let borrow = null;
    try {
      borrow = await borrowsBooksCollection.findOne({ _id: new ObjectId(id) });
    } catch {
      return res.status(400).json({ message: "Invalid borrow record ID format" });
    }

    if (!borrow) {
      return res.status(404).json({ message: "Borrow record not found" });
    }

    // 1. Delete borrow record
    const result = await borrowsBooksCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Borrow record not found" });
    }

    // 2. Increase inventory for the returned book, never negative
    if (borrow.bookId) {
      try {
        const book = await booksCollection.findOne({ _id: new ObjectId(borrow.bookId) });
        if (book) {
          const currentCopies = Math.max(0, Number(book.totalCopies) || 0);
          const newCopies = Math.max(0, currentCopies + 1);
          await booksCollection.updateOne(
            { _id: new ObjectId(borrow.bookId) },
            { $set: { totalCopies: newCopies } }
          );
        }
      } catch (bookErr) {
        console.error("Failed to restore inventory on book return:", bookErr);
      }
    }

    res.json({ message: "Borrow record deleted and book returned successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete borrow record" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server is running at ${process.env.PORT}`);
});
