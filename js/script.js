let workouts = JSON.parse(localStorage.getItem("workouts")) || [];
let exercises = JSON.parse(localStorage.getItem("exercises")) || [
  "Жим лёжа",
  "Бицепс",
  "Присед"
];


function loadExercises() {
  let select = document.getElementById("exerciseSelect");
  select.innerHTML = "";

  exercises.forEach(ex => {
    let option = document.createElement("option");
    option.value = ex;
    option.textContent = ex;
    select.appendChild(option);
  });
}

function addExercise() {
  let input = document.getElementById("newExercise");
  let value = input.value.trim();

  if (!value) return;

  exercises.push(value);
  localStorage.setItem("exercises", JSON.stringify(exercises));

  input.value = "";
  loadExercises();
}


function addWorkout() {
  let exercise = document.getElementById("exerciseSelect").value;
 let weight = parseFloat(document.getElementById("weight").value);
let sets = parseInt(document.getElementById("sets").value);

if (weight < 0 || sets < 0) {
  alert("Вес и подходы не могут быть меньше 0");
  return;
}
  if (!weight || !sets) return;

  let workout = {
    exercise,
    weight,
    sets,
    date: new Date().toLocaleDateString()
  };

  workouts.push(workout);
  localStorage.setItem("workouts", JSON.stringify(workouts));

  render();
}


function render() {
  let list = document.getElementById("list");
  list.innerHTML = "";

  workouts.slice().reverse().forEach(w => {
    let li = document.createElement("li");
    li.textContent = `${w.date} — ${w.exercise}: ${w.weight} кг (${w.sets} подходов)`;
    list.appendChild(li);
  });
}

// ТЕМА
function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("theme",
    document.body.classList.contains("dark") ? "dark" : "light"
  );
}

function loadTheme() {
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark");
  }
}


function toggleMenu() {
  let menu = document.getElementById("menu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}


loadTheme();
loadExercises();
render();
