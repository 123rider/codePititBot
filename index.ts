import { file, stdout } from "bun";

type Config = {
  cred: {
    username: string;
    password: string;
  };
  apiKey?: string[];
  answer?: string;
};

type Problem = {
  id: string;
  title: string;
  completed: boolean;
};

// remove this by reading this from a file
const config: Config = {
  cred: {
    username: "ENTER_USER_HERE",
    password: "ENTER_PASSWORD_HERE",
  },
  apiKey: [],
  answer: "./answer",
};

const delay: (ms: number) => Promise<unknown> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

await using view = new Bun.WebView({
  width: 1200,
  height: 800,
  headless: true,
});

await view.navigate("https://code.ptit.edu.vn/");

if (view.url == "https://code.ptit.edu.vn/login") {
  await login();
}

await delay(1000);
if (view.url != "https://code.ptit.edu.vn/student/question") {
  console.error("error when enetering cred");
  process.exit(1);
}

const tasks = await getTask();
console.log(tasks);
for (const task of tasks) {
  if (!task.completed) {
    console.log(`Processing: [${task.id}] - ${task.title}`);
    await view.navigate(`https://code.ptit.edu.vn/student/question/${task.id}`);
    const task_des = (await view.evaluate(
      'document.querySelector(".submit__des").outerHTML',
    )) as any;

    // get llvm here
    // const res = await generateCppSolution(task.id,task.title,task_des)
    // if (res){await Bun.write(`./tmp/${task.id}.cpp`,res)}
    await delay(2000);
    const cppFile = await getLocalCppSolution(task.id, task.title, task_des);

    if (await cppFile.exists()) {
      // 2. Read the raw text of the C++ code
      const cppCode = await cppFile.text();
      const fileName = `${task.id}.cpp`;

      console.log(`Uploading solution for [${task.id}]...`);

      // 3. Inject JS to attach the file to the DOM element and submit
      const uploadSuccess = await uploadAndSubmit(cppCode, fileName);

      if (uploadSuccess) {
        console.log(`Successfully submitted solution for [${task.id}]`);
      } else {
        console.error(`Failed to submit solution for [${task.id}]`);
      }
    } else {
      console.warn(`Local solution file not found for task: ${task.id}`);
    }

    // Give the page time to load completely or perform actions
    await delay(10000);
  }
}

async function getTask() {
  const sum_task: Array<Problem> = [];

  for (let i = 0; i <= 2; i++) {
    console.log(`reading page ${i + 1}`);
    await view.navigate(
      `https://code.ptit.edu.vn/student/question?page=${i + 1}`,
    );
    const payload = `(() => {
  // Select all table rows in the document
  const rows = Array.from(document.querySelectorAll('table tr'))

  return rows.map(row => {
    // 1. Check if the row has enough cells to prevent empty/header row errors
    const cells = row.querySelectorAll('td')
    if (cells.length < 5) return null;

    // 2. Extract ID (from the first anchor link)
    const idLink = cells[2]?.querySelector('a')
    const id = idLink ? idLink.innerText.trim() : null

    // 3. Extract Title (from the second anchor link)
    const titleLink = cells[3]?.querySelector('a')
    const title = titleLink ? titleLink.innerText.trim() : null

    // Skip row if it doesn't contain a valid ID or Title
    if (!id || !title) return null

    // 4. Check if completed (returns true if classList contains 'bg--10th')
    const completed = row.classList.contains('bg--10th')

    return { id, title, completed }
  }).filter(Boolean) // Filter out any null rows (like headers or empty rows)
  })()`;

    const tasks = (await view.evaluate(payload)) as Array<Problem>;
    tasks.map((v) => {
      sum_task.push(v);
    });
  }
  return sum_task as Array<Problem>;
}

async function login() {
  console.log(view.title);
  console.log("Entering user cred");
  await view.click("#login__user");
  await view.type(config.cred.username);

  await view.click("#login__pw");
  await view.type(config.cred.password);

  await view.click('button[type="submit"]');
}

await waitForSignal();

function waitForSignal() {
  return new Promise((resolve) => {
    // 1. Define the signal handler
    const handleSignal = () => {
      console.log("SIGTERM received. Handling gracefully...");
      cleanup();
    };

    // 2. Define a cleanup function to prevent memory leaks
    const cleanup = () => {
      process.off("SIGTERM", handleSignal); // Remove the listener
      resolve(undefined); // Resolve the promise to let code continue
    };
    // 4. Listen for the signal
    process.on("SIGTERM", handleSignal);
  });
}

async function getLocalCppSolution(
  id: string,
  title: string,
  htmlContent: string,
) {
  const file = Bun.file(`${config.answer}/${id}.cpp`);
  return file;
}

async function generateCppSolution(
  id: string,
  title: string,
  htmlContent: string,
): Promise<string | null> {
  const apiKey = "PUT THE API KEY HERE";
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY environment variable.");
    process.exit(1);
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `You are an expert competitive programmer. Solve the programming problem detailed in this raw HTML content.
            
            Requirements:
            1. Write optimized, bug-free C++ code that handles all edge cases and complies with standard competitive programming input/output formats (using cin/cout).
            2. Return ONLY the raw C++ source code.
            3. Do NOT wrap the code in markdown code blocks (do not use \`\`\`cpp).
            4. Do NOT include any explanations, introduction, or trailing comments outside the source code.

            HTML Content:
            ${htmlContent}`,
                },
              ],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error (${response.status}):`, errorText);
      return null;
    }

    const data = (await response.json()) as any;
    let code = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!code) {
      console.error("Invalid response structure from Gemini API:", data);
      return null;
    }

    // Safeguard: Strip markdown code blocks if the LLM ignores instructions
    // This regex removes ```cpp or ``` lines from the start and ``` from the end
    if (code.startsWith("```")) {
      code = code.replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/g, "$1").trim();
    }

    return code;
  } catch (error) {
    console.error("Failed to generate C++ solution:", error);
    return null;
  }
}

async function uploadAndSubmit(
  fileContent: string,
  fileName: string,
): Promise<boolean> {
  // We stringify the code and filename safely into the payload execution context
  const payload = `(() => {
    try {
      // 1. Find the file input field (Adjust selector if code.ptit.edu.vn uses a different id/class)
      const fileInput = document.querySelector('input[type="file"]') || document.querySelector('#file-upload');
      if (!fileInput) {
        console.error("File input element not found on page.");
        return false;
      }

      // 2. Programmatically create a File object in the browser context
      const blob = new Blob([\`${fileContent.replace(/`/g, "\\`").replace(/\${/g, "\\${")}\`], { type: 'text/x-csrc' });
      const file = new File([blob], "${fileName}", { type: 'text/x-csrc' });

      // 3. Bind the file to the input's files DataTransfer list
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // 4. Dispatch events so any framework state listeners (Vue/React/Vanilla) detect the change
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      // 5. Locate and click the Submit button 
      // Look for standard buttons containing text like "Nộp bài", "Submit", or specific class flags
      const submitBtn = document.querySelector('button[type="submit"]') || 
                        Array.from(document.querySelectorAll('button, input[type="submit"]'))
                             .find(el => el.textContent.includes('Nộp') || el.textContent.toLowerCase().includes('submit'));

      if (!submitBtn) {
        console.error("Submit button not found.");
        return false;
      }

      submitBtn.click();
      return true;
    } catch (err) {
      console.error("Error during browser-side file assignment:", err);
      return false;
    }
  })()`;

  return (await view.evaluate(payload)) as boolean;
}
