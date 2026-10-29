// Get search elements
const projectSearchForm = document.getElementById("projectSearchForm");
const projectSearchInput = document.getElementById("projectSearch");
const projectResults = document.getElementById("projectResults");
const projectsStatus = document.getElementById("projectsStatus");


// Search for projects
async function searchProjects(keyword) {

    try {

        projectsStatus.textContent = "Searching projects...";

        const response = await fetch(`/api/projects?search=${encodeURIComponent(keyword)}`);

        if (!response.ok) {
            throw new Error("Failed to retrieve projects");
        }

        const projects = await response.json();

        displayProjects(projects);

    } catch (error) {

        console.error("Error searching projects:", error);

        projectsStatus.textContent = "An error occurred while searching projects.";

    }

}


// Display search results
function displayProjects(projects) {

    projectResults.innerHTML = "";

    if (projects.length === 0) {

        projectsStatus.textContent = "No matching projects found.";

        return;

    }

    projectsStatus.textContent = `${projects.length} project(s) found.`;

    projects.forEach(project => {

        // Create project container
        const projectCard = document.createElement("div");
        projectCard.className = "project-card";

        // Project title
        const projectTitle = document.createElement("h3");
        projectTitle.textContent = project.ProjectName;

        // Project description
        const projectDescription = document.createElement("p");
        projectDescription.textContent = project.ProjectDescription || "";

        // Project industry
        const projectIndustry = document.createElement("p");
        projectIndustry.textContent = `Industry: ${project.Industry || "Not specified"}`;

        // Project keywords
        const projectKeywords = document.createElement("p");
        projectKeywords.textContent = `Keywords: ${project.Keywords || "None"}`;

        // Project PDF link
        if (project.PDFID) {

            const projectPDF = document.createElement("a");

            projectPDF.href = `/api/projects/${project.ProjectID}/pdf`;
            projectPDF.textContent = "View Project PDF";
            projectPDF.target = "_blank";
            projectPDF.rel = "noopener noreferrer";

            projectCard.appendChild(projectPDF);

        }

        projectCard.appendChild(projectTitle);
        projectCard.appendChild(projectDescription);
        projectCard.appendChild(projectIndustry);
        projectCard.appendChild(projectKeywords);

        projectResults.appendChild(projectCard);

    });

}


// Handle search form submission
projectSearchForm.addEventListener("submit", function(event) {

    event.preventDefault();

    const keyword = projectSearchInput.value.trim();

    searchProjects(keyword);

});


// Load all approved projects when the page opens
searchProjects("");