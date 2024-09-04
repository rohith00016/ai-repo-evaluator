const express = require("express");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const axios = require("axios");
require("dotenv").config();
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// Helper function to read file content
const readFile = (filePath) => {
  return fs.readFileSync(filePath, "utf8");
};

// Function to get the absolute path of a file based on import statement
const resolveFilePath = (importPath, repoPath) => {
  if (importPath.startsWith("react-dom/") || importPath.startsWith("react/")) {
    return null;
  }

  let filePath = path.join(repoPath, "src", importPath);

  if (!fs.existsSync(filePath) && !importPath.endsWith(".jsx")) {
    filePath = path.join(repoPath, "src", importPath + ".jsx");
  }

  if (!fs.existsSync(filePath)) {
    console.warn(`File not found at resolved path: ${filePath}`);
    return null;
  }

  return filePath;
};

// Function to extract imports from file content
const extractImports = (content) => {
  const importRegex = /import\s+.*\s+from\s+['"](.*)['"]/g;
  const imports = [];
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
};

// Function to read files for evaluation based on imports
const readFilesForEvaluation = (repoPath, imports) => {
  const allFileContents = [];
  const filePaths = new Set();

  for (const imp of imports) {
    const filePath = resolveFilePath(imp, repoPath);
    if (filePath) {
      filePaths.add(filePath);
    }
  }

  for (const filePath of filePaths) {
    console.log(`Reading file: ${filePath}`);
    try {
      allFileContents.push(readFile(filePath));
    } catch (err) {
      console.error(`Error reading file ${filePath}:`, err.message);
    }
  }

  return allFileContents;
};

// Function to clean the AI response
const cleanAIResponse = (response) => {
  const jsonStart = response.indexOf("{");
  const jsonEnd = response.lastIndexOf("}");

  if (jsonStart !== -1 && jsonEnd !== -1) {
    return response.substring(jsonStart, jsonEnd + 1);
  }

  throw new Error("Invalid JSON format");
};

// Function to clean up the cloned repository
const cleanupRepository = (repoPath) => {
  if (fs.existsSync(repoPath)) {
    fs.rm(repoPath, { recursive: true, force: true }, (err) => {
      if (err) {
        console.error(
          `Error cleaning up repository at ${repoPath}:`,
          err.message
        );
      } else {
        console.log(`Cleaned up repository at ${repoPath}`);
      }
    });
  }
};

// Endpoint to evaluate the repository
app.post("/evaluate", async (req, res) => {
  const { repoUrl } = req.body;
  const repoPath = path.join(process.cwd(), "cloned-repo");

  try {
    if (!fs.existsSync(repoPath)) {
      console.log(`Cloning repository from ${repoUrl} into ${repoPath}`);
      await simpleGit().clone(repoUrl, repoPath);
    } else {
      console.log(`Repository already exists at ${repoPath}`);
    }

    console.log(
      `Contents of ${repoPath}:`,
      fs.readdirSync(repoPath, { withFileTypes: true })
    );

    const entryFilePath = path.join(repoPath, "src", "main.jsx");
    console.log(`Reading file from ${entryFilePath}`);
    const entryContent = readFile(entryFilePath);

    const imports = extractImports(entryContent);
    console.log("Imports found:", imports);

    const allFileContents = readFilesForEvaluation(repoPath, imports);

    const combinedCodeContent = allFileContents.join("\n");

    try {
      const aiEvaluation = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: "You are a code reviewer.",
            },
            {
              role: "user",
              content: `
                    Evaluate the following React code and provide scores out of 10. Break down the score as follows:
                    1. Displays a list of products with their name and description: 2 marks
                    2. Allows adding items to the cart and updating the cart quantity: 2 marks
                    3. Changes the "Add to Cart" button to "Remove from Cart" once an item is added: 2 marks
                    4. Allows removing items from the cart and updates the cart quantity accordingly: 2 marks
                    5. The code follows best practices and is clean and maintainable: 2 marks
  
                    Code: 
                    ${combinedCodeContent}
  
                    Provide a detailed analysis, individual scores for each criterion, and the total score out of 10 in the following JSON format:

                    {
                      "analysis": "Overall analysis of the code.",
                      "scores": {
                        "Displays products": 2,
                        "Adds items to cart": 2,
                        "Changes button state": 2,
                        "Removes items from cart": 2,
                        "Best practices": 2
                      },
                      "totalScore": 10
                    }`,
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

      // Clean the response to ensure it's valid JSON
      const cleanResponse = cleanAIResponse(
        aiEvaluation.data.choices[0].message.content.trim()
      );
      const aiFeedback = JSON.parse(cleanResponse);

      res.json({ feedback: aiFeedback });
    } catch (aiError) {
      console.error(
        "AI Evaluation Error:",
        aiError.response ? aiError.response.data : aiError.message
      );
      res
        .status(500)
        .json({ error: "AI evaluation failed", details: aiError.message });
    } finally {
      cleanupRepository(repoPath);
    }
  } catch (err) {
    res
      .status(500)
      .json({ error: "Repository evaluation failed", details: err.message });
  } finally {
    cleanupRepository(repoPath);
  }
});

app.listen(3000, () => console.log("Server is running on port 3000"));
