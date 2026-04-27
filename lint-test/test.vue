<template>
  <section>
    <h1>{{ title }}</h1>
  </section>
</template>

<script setup>
const title = 'Lint test'
const unused = 123

console.log(title)
</script>

<style scoped>
.title {
  color: red;
}
</style>
