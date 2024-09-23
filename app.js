const express = require("express");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const axios = require("axios");
const cheerio = require("cheerio");
require("dotenv").config();
const cors = require("cors");
const { log } = require("console");

const app = express();
app.use(express.json());
app.use(cors());

// Helper function to read file content
const readFile = (filePath) => {
  if (!filePath) {
    throw new Error("filePath is undefined");
  }
  return fs.readFileSync(filePath, "utf8");
};

// Function to clean up the cloned repository using fs.rm
const cleanupRepository = (repoPath) => {
  if (!repoPath) {
    throw new Error("repoPath is undefined");
  }
  return new Promise((resolve, reject) => {
    fs.rm(repoPath, { recursive: true, force: true }, (err) => {
      if (err) {
        console.error(
          `Error cleaning up repository at ${repoPath}:`,
          err.message
        );
        reject(err);
      } else {
        console.log(`Cleaned up repository at ${repoPath}`);
        resolve();
      }
    });
  });
};

// Extract JavaScript and CSS files from HTML content
const extractJSAndCSSFiles = (htmlContent, repoPath) => {
  if (!htmlContent || !repoPath) {
    throw new Error("htmlContent or repoPath is undefined");
  }
  const $ = cheerio.load(htmlContent);
  const jsFiles = [];
  const cssFiles = [];

  $("script[src]").each((index, element) => {
    const scriptSrc = $(element).attr("src");
    if (scriptSrc) {
      const fullPath = path.join(repoPath, scriptSrc);
      jsFiles.push(fullPath);
    }
  });

  $('link[rel="stylesheet"]').each((index, element) => {
    const stylesheetHref = $(element).attr("href");
    if (stylesheetHref) {
      const fullPath = path.join(repoPath, stylesheetHref);
      cssFiles.push(fullPath);
    }
  });

  return { jsFiles, cssFiles };
};

// Extract imports from file content
const extractImports = (content) => {
  const importRegex = /import\s+.*\s+from\s+['"](.*)['"]/g;
  const imports = [];
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
};

// Read files for evaluation based on imports
const readFilesForEvaluation = (repoPath, imports) => {
  if (!repoPath || !Array.isArray(imports)) {
    throw new Error("repoPath or imports is undefined or not an array");
  }
  const allFileContents = [];
  const filePaths = new Set();

  for (const imp of imports) {
    const filePath = path.join(repoPath, "src", imp);
    if (fs.existsSync(filePath)) {
      filePaths.add(filePath);
    }
  }

  for (const filePath of filePaths) {
    console.log(`Reading file: ${filePath}`);
    allFileContents.push(readFile(filePath));
  }

  return allFileContents;
};

// Function to generate evaluation content
const generateEvaluationContent = (cases, totalMarks, combinedCodeContent) => {
  const marksPerCase = Math.floor(totalMarks / cases.length);
  const remainingMarks = totalMarks % cases.length;
  let content = `Evaluate the following React code and provide scores out of ${totalMarks}. Break down the score as follows:\n`;

  cases.forEach((task, index) => {
    const assignedMarks = marksPerCase + (index < remainingMarks ? 1 : 0);
    content += `${index + 1}. ${task}: ${assignedMarks} marks\n`;
  });

  content += `\nCode:\n${combinedCodeContent}\n\nProvide a detailed analysis, individual scores for each criterion, and the total score out of ${totalMarks} in the following JSON format:\n\n{
    "analysis": "Overall analysis of the code.",
    "scores": {\n`;

  cases.forEach((task, index) => {
    const assignedMarks = marksPerCase + (index < remainingMarks ? 1 : 0);
    content += `    "${task}": ${assignedMarks}${
      index < cases.length - 1 ? "," : ""
    }\n`;
  });

  content += `  },\n  "totalScore": ${totalMarks}\n}`;

  return content;
};

// Function to clean the AI response
const cleanAIResponse = (response) => {
  if (!response) {
    throw new Error("AI response is undefined");
  }
  const jsonStart = response.indexOf("{");
  const jsonEnd = response.lastIndexOf("}");

  if (jsonStart !== -1 && jsonEnd !== -1) {
    return response.substring(jsonStart, jsonEnd + 1);
  }

  throw new Error("Invalid JSON format");
};

// Endpoint to evaluate the repository
app.post("/evaluate", async (req, res) => {
  const { repoUrl, title } = req.body;
  let cases = [];

  if (title.toLowerCase() === "memory game") {
    cases = [
      "Create a basic HTML layout with a container for the game board.",
      "Include a header with the game title and a restart button.",
      "Implement the game logic to handle card flipping.",
      "Implement a shuffle function to randomize the card positions.",
      "Track the state of the game (flipped cards, found pairs).",
      "Implement logic to check for matching pairs.",
      "Add a restart function that resets the game board.",
      "Clean, well-documented code for HTML, CSS, and JS.",
      "A responsive design for desktop and mobile.",
      "A README file explaining the project setup and play instructions.",
    ];
  }

  if (title.toLowerCase() === "shopping cart") {
    cases = [
      "Display a list of available products with their name and description.",
      "Users can add items to the cart by clicking the 'Add to Cart' button.",
      "When an item is added, the cart quantity number should increase.",
      "Change 'Add to Cart' button to 'Remove from Cart' once the item is added.",
      "Users can remove items from the cart by clicking the 'Remove from Cart' button.",
      "When an item is removed, the cart quantity number should decrease.",
      "Change 'Remove from Cart' button back to 'Add to Cart' once the item is removed.",
    ];
  }

  if (title.toLowerCase() === "custom test cases") {
    cases = req.body.customTestCases;
    console.log(cases);
  }

  const totalMarks = 10;
  const repoPath = path.join(process.cwd(), "cloned-repo");

  try {
    // Check and clean up existing repository
    if (fs.existsSync(repoPath)) {
      console.log("Repository already exists. Cleaning it up first...");
      await cleanupRepository(repoPath);
    }

    // Clone repository
    console.log(`Cloning repository from ${repoUrl} into ${repoPath}`);
    await simpleGit().clone(repoUrl, repoPath);

    // Evaluate the repository
    await evaluateRepo(repoPath, res, title, cases, totalMarks);
  } catch (err) {
    console.error("Repository evaluation error:", err.message);
    res
      .status(500)
      .json({ error: "Repository evaluation failed", details: err.message });
  }
});

const evaluateRepo = async (repoPath, res, title, cases, totalMarks) => {
  let entryFilePath = "";
  let combinedCodeContent = "";

  try {
    if (title.toLowerCase() === "memory game") {
      entryFilePath = path.join(repoPath, "index.html");
      console.log(`Reading file from ${entryFilePath}`);

      // Read index.html
      const indexContent = readFile(entryFilePath);
      console.log("index.html content:", indexContent);

      // Extract JavaScript and CSS files from index.html
      const { jsFiles, cssFiles } = extractJSAndCSSFiles(
        indexContent,
        repoPath
      );
      const filesToRead = [entryFilePath, ...jsFiles, ...cssFiles];
      combinedCodeContent = filesToRead
        .map((file) => readFile(file))
        .join("\n");
    } else {
      entryFilePath = path.join(repoPath, "src", "main.jsx");
      console.log(`Reading file from ${entryFilePath}`);

      // Read main.jsx
      const entryContent = readFile(entryFilePath);
      const imports = extractImports(entryContent);
      console.log("Imports found:", imports);

      const allFileContents = readFilesForEvaluation(repoPath, imports);
      combinedCodeContent = allFileContents.join("\n");
    }

    // AI evaluation via OpenAI API
    const aiEvaluation = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a code reviewer." },
          {
            role: "user",
            content: generateEvaluationContent(
              cases,
              totalMarks,
              combinedCodeContent
            ),
          },
        ],
        max_tokens: 500,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const cleanResponse = cleanAIResponse(
      aiEvaluation.data.choices[0].message.content.trim()
    );
    const aiFeedback = JSON.parse(cleanResponse);

    // Respond with AI feedback
    res.json({ feedback: aiFeedback });
  } catch (err) {
    console.error("Repository evaluation error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to evaluate repository", details: err.message });
  } finally {
    // Clean up repository after evaluation
    await cleanupRepository(repoPath);
  }
};

// Start the server
app.listen(3000, () => console.log("Server is running on port 3000"));
