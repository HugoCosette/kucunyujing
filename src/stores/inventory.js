import { ref } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'

export const useInventoryStore = defineStore('inventory', () => {
  const inventoryItems = ref(initialInventoryItems.map((item) => ({ ...item })))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})

  return { inventoryItems, purchaseList, plannedUndoHistory }
})
