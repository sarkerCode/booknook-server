import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";
import { createRemoteJWKSet } from "jose";

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

const JWKS = createRemoteJWKSet(new URL(process.env.JWKS_URI));

export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  // 1. Check if Authorization header exists and starts with Bearer
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (err) {
    console.error("JWT Verify Error:", err.message);
    return res.status(403).json({ message: "Forbidden: Invalid or expired token" });
  }
};


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

//Borrowed Books API - borrow a book, check double borrow, and decrease copies with $inc
app.post("/my-borrows", async (req, res) => {
  const borrow = req.body;
  try {
    if (!borrow.bookId) {
      return res.status(400).json({ message: "Book ID is required" });
    }

    if (!borrow.userEmail) {
      return res.status(400).json({ message: "User email is required" });
    }

    // 1. No Double Borrow: Check if user already borrowed this book
    const existingBorrow = await borrowsBooksCollection.findOne({
      userEmail: borrow.userEmail,
      bookId: borrow.bookId,
    });

    if (existingBorrow) {
      return res.status(400).json({
        message: "You have already borrowed this book. You cannot borrow the same book twice at the same time.",
      });
    }

    // 2. Find book to verify existence
    let book = null;
    try {
      book = await booksCollection.findOne({ _id: new ObjectId(borrow.bookId) });
    } catch {
      return res.status(400).json({ message: "Invalid Book ID format" });
    }

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    // Ensure totalCopies is a numeric value in DB for $inc operator compatibility
    if (typeof book.totalCopies === "string") {
      await booksCollection.updateOne(
        { _id: new ObjectId(borrow.bookId) },
        { $set: { totalCopies: Math.max(0, Number(book.totalCopies) || 0) } }
      );
    }

    // 3. Atomically decrease copies by 1 with $inc (only if totalCopies > 0)
    const updateResult = await booksCollection.findOneAndUpdate(
      {
        _id: new ObjectId(borrow.bookId),
        totalCopies: { $gt: 0 },
      },
      {
        $inc: { totalCopies: -1 },
      },
      { returnDocument: "after" }
    );

    if (!updateResult) {
      return res.status(400).json({ message: "This book is currently not available." });
    }

    const remainingCopies = updateResult.totalCopies;

    // 4. Save borrow record
    const result = await borrowsBooksCollection.insertOne(borrow);
    res.status(201).json({
      message: "Borrow record added successfully",
      borrowId: result.insertedId,
      remainingCopies,
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

//delete borrowed book / return a book and increase copies by 1 with $inc
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

    // 2. Increase inventory for the returned book by 1 with $inc
    if (borrow.bookId) {
      try {
        const book = await booksCollection.findOne({ _id: new ObjectId(borrow.bookId) });
        if (book && typeof book.totalCopies === "string") {
          await booksCollection.updateOne(
            { _id: new ObjectId(borrow.bookId) },
            { $set: { totalCopies: Math.max(0, Number(book.totalCopies) || 0) } }
          );
        }

        await booksCollection.updateOne(
          { _id: new ObjectId(borrow.bookId) },
          { $inc: { totalCopies: 1 } }
        );
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
