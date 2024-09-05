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

// Function to clean up the cloned repository using fs.rm
const cleanupRepository = (repoPath) => {
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

// Endpoint to evaluate the repository
app.post("/evaluate", async (req, res) => {
  const { repoUrl, cases } = req.body;
  const repoPath = path.join(process.cwd(), "cloned-repo");

  try {
    if (fs.existsSync(repoPath)) {
      console.log("Repository already exists. Cleaning it up first...");
      // Remove the existing repository before cloning
      await cleanupRepository(repoPath);
    }

    console.log(`Cloning repository from ${repoUrl} into ${repoPath}`);
    await simpleGit().clone(repoUrl, repoPath);

    // Call the evaluation logic after cloning
    evaluateRepo(repoPath, res, cases);
  } catch (err) {
    console.error("Repository evaluation error:", err.message);
    res
      .status(500)
      .json({ error: "Repository evaluation failed", details: err.message });
  }
});

// Function to evaluate repository after cloning
const evaluateRepo = async (repoPath, res, cases) => {
  const entryFilePath = path.join(repoPath, "src", "main.jsx");
  console.log(`Reading file from ${entryFilePath}`);

  try {
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
                    1. ${cases[0]}: 2 marks
                    2. ${cases[1]}: 2 marks
                    3. ${cases[2]}: 2 marks
                    4. ${cases[3]}: 2 marks
                    5. ${cases[4]}: 2 marks
  
                    Code: 
                    ${combinedCodeContent}
  
                    Provide a detailed analysis, individual scores for each criterion, and the total score out of 10 in the following JSON format:

                    {
                      "analysis": "Overall analysis of the code.",
                      "scores": {
                        ${cases[0]}: 2,
                        ${cases[1]}: 2,
                        ${cases[2]}: 2,
                        ${cases[3]}: 2,
                        ${cases[4]}: 2
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
      // Clean up after evaluation
      await cleanupRepository(repoPath);
    }
  } catch (err) {
    console.error("Repository evaluation error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to evaluate repository", details: err.message });
    await cleanupRepository(repoPath); // Clean up after error
  }
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

// Function to clean the AI response
const cleanAIResponse = (response) => {
  const jsonStart = response.indexOf("{");
  const jsonEnd = response.lastIndexOf("}");

  if (jsonStart !== -1 && jsonEnd !== -1) {
    return response.substring(jsonStart, jsonEnd + 1);
  }

  throw new Error("Invalid JSON format");
};

app.listen(3000, () => console.log("Server is running on port 3000"));
